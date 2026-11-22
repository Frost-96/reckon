import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type BusinessMockUnderTest, inMinutes, startBusinessMock } from "./test-support.ts";

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

function createAftersales(key: string | undefined, overrides: Record<string, unknown> = {}) {
  return mock.app.inject({
    method: "POST",
    url: "/aftersales",
    headers: key === undefined ? {} : { "idempotency-key": key },
    payload: {
      customerId: "C1",
      orderId: "O1",
      lineId: "L1",
      quantity: 1,
      reason: "Arrived broken",
      returnFeeCents: 800,
      clientRef: "op-create-1",
      deadline: inMinutes(5),
      ...overrides,
    },
  });
}

async function aftersalesOfC1(): Promise<Array<{ id: string }>> {
  return (await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" })).json();
}

test("the same key with the same parameters returns the original result", async () => {
  const first = await createAftersales("op-create-1");

  const again = await createAftersales("op-create-1");

  expect(again.statusCode).toBe(201);
  expect(again.json()).toEqual(first.json());
  expect(again.headers["idempotent-replayed"]).toBe("true");
  expect(await aftersalesOfC1()).toHaveLength(1);
});

test("a retry with a fresh deadline still counts as the same parameters", async () => {
  const first = await createAftersales("op-create-1", { deadline: inMinutes(5) });

  const retry = await createAftersales("op-create-1", { deadline: inMinutes(10) });

  expect(retry.statusCode).toBe(201);
  expect(retry.json()).toEqual(first.json());
});

test("the same key with different parameters is refused as a mismatch", async () => {
  await createAftersales("op-create-1", { quantity: 1 });

  const response = await createAftersales("op-create-1", { quantity: 2 });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({
    error: { code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" },
  });
  expect(await aftersalesOfC1()).toHaveLength(1);
});

test("the same key sent again while the first request is processing is refused", async () => {
  await mock.configure({ processingDelayMs: 300 });

  const responses = await Promise.all([
    createAftersales("op-create-1"),
    createAftersales("op-create-1"),
  ]);

  const outcomes = responses.map((response) => [response.statusCode, response.json().error?.code]);
  expect(outcomes).toEqual(
    expect.arrayContaining([
      [201, undefined],
      [409, "IDEMPOTENCY_CONCURRENT_REQUEST"],
    ]),
  );
  expect(await aftersalesOfC1()).toHaveLength(1);
});

test("a rejected request does not take the key", async () => {
  const rejected = await createAftersales("op-create-1", { returnFeeCents: 500 });
  expect(rejected.json()).toMatchObject({ error: { code: "FEE_CHANGED" } });

  const reconfirmed = await createAftersales("op-create-1", { returnFeeCents: 800 });

  expect(reconfirmed.statusCode).toBe(201);
});

test("a write without an idempotency key is refused", async () => {
  const response = await createAftersales(undefined);

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
});

test("a retried return shipment returns the original instead of a duplicate refusal", async () => {
  const aftersalesId = (await createAftersales("op-create-1")).json().id;
  const ship = () =>
    mock.app.inject({
      method: "POST",
      url: `/aftersales/${aftersalesId}/return-shipments`,
      headers: { "idempotency-key": "op-ship-1" },
      payload: { customerId: "C1", clientRef: "op-ship-1", deadline: inMinutes(5) },
    });
  const first = await ship();

  const retry = await ship();

  expect(retry.statusCode).toBe(201);
  expect(retry.json()).toEqual(first.json());
});
