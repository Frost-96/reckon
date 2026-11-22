import type { AddressInfo } from "node:net";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import {
  createExecutor,
  createScriptedModel,
  createTask,
  type ExecutionDb,
  listUserVisibleMessages,
  type ModelRequest,
  postCustomerMessage,
  type ScriptedStep,
} from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createAftersalesPackage } from "./index.ts";

let mock: BusinessMockUnderTest;
let businessServiceUrl: string;
let database: ExecutionTestDatabase;
let db: ExecutionDb;

beforeAll(async () => {
  mock = await startBusinessMock();
  await mock.app.listen({ host: "127.0.0.1", port: 0 });
  businessServiceUrl = `http://127.0.0.1:${(mock.app.server.address() as AddressInfo).port}`;
  database = await startExecutionTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.close();
  await mock.close();
});

beforeEach(async () => {
  await mock.reset();
});

async function askAgent(customerId: string, message: string, script: ScriptedStep[]) {
  const task = await createTask(db, { customerId });
  await postCustomerMessage(db, task.id, message);
  const model = createScriptedModel(script);
  const executor = createExecutor({
    db,
    owner: "executor-1",
    businessPackage: createAftersalesPackage({ businessServiceUrl }),
    model,
  });
  await executor.runOnce();
  return { model, messages: await listUserVisibleMessages(db, task.id) };
}

function lastToolResult(request: ModelRequest | undefined): unknown {
  const message = request?.messages.at(-1);
  if (message?.role !== "tool") {
    throw new Error("The request does not end with a tool result");
  }
  return JSON.parse(message.content);
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
