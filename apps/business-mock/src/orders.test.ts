import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type BusinessMockUnderTest, startBusinessMock } from "./test-support.ts";

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

test("a customer can query one of their orders with returnable quantities", async () => {
  const response = await mock.app.inject({ method: "GET", url: "/customers/C1/orders/O1" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    id: "O1",
    customerId: "C1",
    status: "delivered",
    lines: [
      { id: "L1", productName: "Kettle", quantity: 2, returnableQuantity: 2 },
      { id: "L2", productName: "Mug", quantity: 1, returnableQuantity: 1 },
    ],
  });
});

test("a customer lists only their own orders", async () => {
  const response = await mock.app.inject({ method: "GET", url: "/customers/C2/orders" });

  expect(response.statusCode).toBe(200);
  expect(response.json().map((order: { id: string }) => order.id)).toEqual(["O2"]);
});

test("another customer's order is not found", async () => {
  const response = await mock.app.inject({ method: "GET", url: "/customers/C2/orders/O1" });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
});

test("aftersales rules give the return deadline and the current return fee", async () => {
  await mock.reset("seed-1", {
    policy: { returnWindowDays: 7, returnFeeCents: 800 },
    orders: [
      {
        id: "O1",
        customerId: "C1",
        status: "delivered",
        deliveredAt: "2026-11-01T08:00:00.000Z",
        lines: [{ id: "L1", productName: "Kettle", quantity: 1 }],
      },
    ],
  });

  const response = await mock.app.inject({
    method: "GET",
    url: "/customers/C1/orders/O1/aftersales-rules",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    orderId: "O1",
    returnWindowDays: 7,
    returnDeadline: "2026-11-08T08:00:00.000Z",
    withinReturnWindow: false,
    returnFeeCents: 800,
  });
});
