import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  type BusinessMockUnderTest,
  daysAgo,
  defaultFixture,
  inMinutes,
  startBusinessMock,
} from "./test-support.ts";

let mock: BusinessMockUnderTest;

beforeAll(async () => {
  mock = await startBusinessMock();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  await mock.reset();
});

function createAftersales(overrides: Record<string, unknown> = {}, key = "op-create-1") {
  return mock.app.inject({
    method: "POST",
    url: "/aftersales",
    headers: { "idempotency-key": key },
    payload: {
      customerId: "C1",
      orderId: "O1",
      lineId: "L1",
      quantity: 1,
      reason: "Arrived broken",
      returnFeeCents: 800,
      clientRef: key,
      deadline: inMinutes(5),
      ...overrides,
    },
  });
}

test("a created aftersales order shows up in the customer's progress with its client ref", async () => {
  const deadline = inMinutes(5);
  const created = await createAftersales({ deadline });

  expect(created.statusCode).toBe(201);
  const progress = await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" });
  expect(progress.statusCode).toBe(200);
  expect(progress.json()).toEqual([
    {
      id: created.json().id,
      orderId: "O1",
      lineId: "L1",
      quantity: 1,
      reason: "Arrived broken",
      status: "in_progress",
      returnFeeCents: 800,
      clientRef: "op-create-1",
      deadline,
      returnShipment: null,
    },
  ]);
});

test.each([
  ["ORDER_NOT_FOUND", { orderId: "O404" }],
  ["ORDER_NOT_OWNED", { customerId: "C2" }],
  ["LINE_NOT_FOUND", { lineId: "L9" }],
  ["QUANTITY_EXCEEDS_RETURNABLE", { quantity: 3 }],
  ["FEE_CHANGED", { returnFeeCents: 500 }],
])("a write is refused with %s and commits nothing", async (code, overrides) => {
  const response = await createAftersales(overrides);

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code } });
  const progress = await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" });
  expect(progress.json()).toEqual([]);
});

function fixtureWithO1(changes: Record<string, unknown>) {
  const fixture = defaultFixture();
  return {
    ...fixture,
    orders: fixture.orders.map((order) => (order.id === "O1" ? { ...order, ...changes } : order)),
  };
}

test("a write for a refunded order is refused", async () => {
  await mock.reset("seed-1", fixtureWithO1({ status: "refunded" }));

  const response = await createAftersales();

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: "ORDER_REFUNDED" } });
});

test("a write after the aftersales window is refused", async () => {
  await mock.reset("seed-1", fixtureWithO1({ deliveredAt: daysAgo(8) }));

  const response = await createAftersales();

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: "AFTERSALES_WINDOW_EXPIRED" } });
});

test("a second application for an item with one in progress is refused", async () => {
  await createAftersales({}, "op-create-1");

  const second = await createAftersales({}, "op-create-2");

  expect(second.statusCode).toBe(422);
  expect(second.json()).toMatchObject({ error: { code: "ACTIVE_AFTERSALES_EXISTS" } });
});

test("someone else's application seeded by the scenario blocks a new one for that item", async () => {
  await mock.reset("seed-1", {
    ...defaultFixture(),
    aftersales: [
      {
        id: "AS-OTHER",
        orderId: "O1",
        lineId: "L1",
        quantity: 1,
        reason: "Filed by phone",
        status: "in_progress",
      },
    ],
  });

  const progress = await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" });
  const response = await createAftersales();

  expect(progress.json()).toMatchObject([{ id: "AS-OTHER", clientRef: null, deadline: null }]);
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: "ACTIVE_AFTERSALES_EXISTS" } });
});

test("with the fee check switched off, a stale fee is accepted as confirmed", async () => {
  await mock.configure({ checkFee: false });

  const response = await createAftersales({ returnFeeCents: 500 });

  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ returnFeeCents: 500 });
});

function createReturnShipment(
  aftersalesId: string,
  overrides: Record<string, unknown> = {},
  key = "op-ship-1",
) {
  return mock.app.inject({
    method: "POST",
    url: `/aftersales/${aftersalesId}/return-shipments`,
    headers: { "idempotency-key": key },
    payload: { customerId: "C1", clientRef: key, deadline: inMinutes(5), ...overrides },
  });
}

test("a generated return shipment shows up in the aftersales progress", async () => {
  const aftersalesId = (await createAftersales()).json().id;

  const shipment = await createReturnShipment(aftersalesId);

  expect(shipment.statusCode).toBe(201);
  const progress = await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" });
  expect(progress.json()[0].returnShipment).toEqual({
    id: shipment.json().id,
    aftersalesId,
    clientRef: "op-ship-1",
    deadline: expect.any(String),
  });
});

test("a second return shipment for the same aftersales order is refused", async () => {
  const aftersalesId = (await createAftersales()).json().id;
  await createReturnShipment(aftersalesId, {}, "op-ship-1");

  const second = await createReturnShipment(aftersalesId, {}, "op-ship-2");

  expect(second.statusCode).toBe(422);
  expect(second.json()).toMatchObject({ error: { code: "RETURN_SHIPMENT_EXISTS" } });
});

test("a return shipment for someone else's aftersales order is refused", async () => {
  const aftersalesId = (await createAftersales()).json().id;

  const response = await createReturnShipment(aftersalesId, { customerId: "C2" });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: "AFTERSALES_NOT_FOUND" } });
});

test("an aftersales order uses up the line's returnable quantity", async () => {
  await createAftersales();

  const order = await mock.app.inject({ method: "GET", url: "/customers/C1/orders/O1" });

  expect(order.json().lines[0]).toMatchObject({ id: "L1", quantity: 2, returnableQuantity: 1 });
});
