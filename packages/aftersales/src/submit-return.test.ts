import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import {
  createExecutor,
  createScriptedModel,
  createTask,
  type ExecutionDb,
  listUserVisibleMessages,
  listWriteIntents,
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

async function runTurn(script: ScriptedStep[]) {
  const model = createScriptedModel(script);
  const executor = createExecutor({
    db,
    owner: "executor-1",
    businessPackage: createAftersalesPackage({ businessServiceUrl }),
    model,
  });
  await executor.runOnce();
  return model;
}

// Turn 1 asks the customer to confirm the return; the customer confirms, starting turn 2.
async function confirmedReturn(customerId: string, parameters: unknown): Promise<string> {
  const task = await createTask(db, { customerId });
  await postCustomerMessage(db, task.id, "我要退一个水壶");
  await runTurn([
    {
      toolCalls: [
        {
          name: "request_confirmation",
          arguments: { tool: "submit_return", parameters, message: "请确认退货信息" },
        },
      ],
    },
  ]);
  const request = (await listUserVisibleMessages(db, task.id)).at(-1);
  if (request?.payload?.kind !== "confirmation_request") {
    throw new Error("The agent did not ask for confirmation");
  }
  await postCustomerMessage(db, task.id, "确认", { confirms: request.seq });
  return task.id;
}

async function aftersalesOf(customerId: string): Promise<unknown[]> {
  const response = await mock.app.inject({ url: `/customers/${customerId}/aftersales` });
  return response.json();
}

function lastToolResult(request: ModelRequest | undefined): unknown {
  const message = request?.messages.at(-1);
  if (message?.role !== "tool") {
    throw new Error("The request does not end with a tool result");
  }
  return JSON.parse(message.content);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const kettleReturn = {
  orderId: "O1",
  lineId: "L1",
  quantity: 1,
  reason: "尺寸不合适",
  returnFeeCents: 800,
};

test("one confirmed submit_return creates exactly one aftersales order and its return shipment", async () => {
  const taskId = await confirmedReturn("C1", kettleReturn);

  const model = await runTurn([
    { toolCalls: [{ name: "submit_return", arguments: kettleReturn }] },
    { content: "退货已提交。" },
  ]);

  // Operation IDs: hash(task, operation, order, line), then hash(first operation ID, operation).
  const createAftersales = sha256(
    `["${taskId}","create_aftersales",{"lineId":"L1","orderId":"O1"}]`,
  );
  const createReturnShipment = sha256(`["${createAftersales}","create_return_shipment"]`);
  const records = await aftersalesOf("C1");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    orderId: "O1",
    lineId: "L1",
    quantity: 1,
    reason: "尺寸不合适",
    returnFeeCents: 800,
    status: "in_progress",
    clientRef: createAftersales,
    returnShipment: { clientRef: createReturnShipment },
  });
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operation: "create_aftersales", operationId: createAftersales, state: "CONFIRMED" },
    { operation: "create_return_shipment", operationId: createReturnShipment, state: "CONFIRMED" },
  ]);
  expect(lastToolResult(model.requests[1])).toMatchObject({
    create_aftersales: { clientRef: createAftersales },
    create_return_shipment: { clientRef: createReturnShipment },
  });
});

test("a business rejection reaches the agent as a structured error and nothing is written", async () => {
  const tooMany = { ...kettleReturn, quantity: 3 };
  const taskId = await confirmedReturn("C1", tooMany);

  const model = await runTurn([
    { toolCalls: [{ name: "submit_return", arguments: tooMany }] },
    { content: "这件商品最多只能退 2 个。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "QUANTITY_EXCEEDS_RETURNABLE", operation: "create_aftersales" },
  });
  expect(await aftersalesOf("C1")).toEqual([]);
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operation: "create_aftersales", state: "REJECTED" },
  ]);
});
