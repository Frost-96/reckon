import { createTask, postCustomerMessage } from "@reckon/kernel";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  type AftersalesUnderTest,
  lastToolResult,
  startAftersalesUnderTest,
} from "./test-support.ts";

// The business service's clock, fixed so deadlines and eligibility are known literals.
const businessNow = new Date("2026-03-10T12:00:00.000Z");

let env: AftersalesUnderTest;

beforeAll(async () => {
  env = await startAftersalesUnderTest({ now: () => businessNow });
});

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await env.mock.reset("seed-1", {
    policy: { returnWindowDays: 7, returnFeeCents: 800 },
    orders: [
      {
        id: "O1",
        customerId: "C1",
        status: "delivered",
        deliveredAt: "2026-03-08T12:00:00.000Z",
        lines: [{ id: "L1", productName: "Kettle", quantity: 2 }],
      },
      {
        id: "O3",
        customerId: "C1",
        status: "delivered",
        deliveredAt: "2026-02-20T12:00:00.000Z",
        lines: [{ id: "L1", productName: "Toaster", quantity: 1 }],
      },
    ],
  });
});

async function askAboutRules(orderId: string): Promise<unknown> {
  const task = await createTask(env.db, { customerId: "C1" });
  await postCustomerMessage(env.db, task.id, `订单 ${orderId} 还能退吗？运费多少？`);
  const model = await env.runTurn([
    { toolCalls: [{ name: "query_aftersales_rules", arguments: { orderId } }] },
    { content: "已为您查询售后规则。" },
  ]);
  return lastToolResult(model.requests[1]);
}

test("before submitting, the agent learns the order's return deadline, eligibility and return fee", async () => {
  expect(await askAboutRules("O1")).toEqual({
    orderId: "O1",
    returnWindowDays: 7,
    returnDeadline: "2026-03-15T12:00:00.000Z",
    withinReturnWindow: true,
    returnFeeCents: 800,
  });
});

test("an order past its return deadline reaches the agent as outside the return window", async () => {
  expect(await askAboutRules("O3")).toMatchObject({
    returnDeadline: "2026-02-27T12:00:00.000Z",
    withinReturnWindow: false,
  });
});
