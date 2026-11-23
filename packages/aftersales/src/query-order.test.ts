import {
  createTask,
  listUserVisibleMessages,
  postCustomerMessage,
  type ScriptedStep,
} from "@reckon/kernel";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  type AftersalesUnderTest,
  lastToolResult,
  startAftersalesUnderTest,
} from "./test-support.ts";

let env: AftersalesUnderTest;

beforeAll(async () => {
  env = await startAftersalesUnderTest();
});

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await env.mock.reset();
});

async function askAgent(customerId: string, message: string, script: ScriptedStep[]) {
  const task = await createTask(env.db, { customerId });
  await postCustomerMessage(env.db, task.id, message);
  const model = await env.runTurn(script);
  return { model, messages: await listUserVisibleMessages(env.db, task.id) };
}

test("the agent looks up the customer's order and replies to the customer", async () => {
  const { model, messages } = await askAgent("C1", "订单 O1 还能退吗？", [
    { toolCalls: [{ name: "query_order", arguments: { orderId: "O1" } }] },
    { content: "订单 O1 的水壶还可退 2 件，杯子可退 1 件。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    id: "O1",
    status: "delivered",
    lines: [
      { id: "L1", productName: "Kettle", quantity: 2, returnableQuantity: 2 },
      { id: "L2", productName: "Mug", quantity: 1, returnableQuantity: 1 },
    ],
  });
  expect(messages).toMatchObject([
    { role: "customer", content: "订单 O1 还能退吗？" },
    { role: "agent", content: "订单 O1 的水壶还可退 2 件，杯子可退 1 件。" },
  ]);
});

test("without an order number the agent sees all of the customer's orders", async () => {
  const { model } = await askAgent("C2", "我有哪些订单？", [
    { toolCalls: [{ name: "query_order", arguments: {} }] },
    { content: "您有一笔订单 O2。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({ orders: [{ id: "O2" }] });
});

test("another customer's order reaches the agent as not found", async () => {
  const { model } = await askAgent("C2", "查一下 O1", [
    { toolCalls: [{ name: "query_order", arguments: { orderId: "O1" } }] },
    { content: "没有找到这笔订单。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
});
