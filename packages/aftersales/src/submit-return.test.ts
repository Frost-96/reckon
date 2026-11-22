import { createHash } from "node:crypto";
import { defaultFixture } from "@reckon/business-mock/test-support";
import { listWriteIntents } from "@reckon/kernel";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  type AftersalesUnderTest,
  confirmLatestRequest,
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

async function aftersalesOf(customerId: string): Promise<unknown[]> {
  const response = await env.mock.app.inject({ url: `/customers/${customerId}/aftersales` });
  return response.json();
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
  const taskId = await env.confirmedReturn("C1", kettleReturn);

  const model = await env.runTurn([
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
  expect(await listWriteIntents(env.db, taskId)).toMatchObject([
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
  const taskId = await env.confirmedReturn("C1", tooMany);

  const model = await env.runTurn([
    { toolCalls: [{ name: "submit_return", arguments: tooMany }] },
    { content: "这件商品最多只能退 2 个。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "QUANTITY_EXCEEDS_RETURNABLE", operation: "create_aftersales" },
  });
  expect(await aftersalesOf("C1")).toEqual([]);
  expect(await listWriteIntents(env.db, taskId)).toMatchObject([
    { operation: "create_aftersales", state: "REJECTED" },
  ]);
});

// Between the customer's confirmation and the write, the business service raises the fee.
async function raiseReturnFee(returnFeeCents: number): Promise<void> {
  await env.mock.reset("seed-1", {
    ...defaultFixture(),
    policy: { returnWindowDays: 7, returnFeeCents },
  });
}

test("after a fee change the return at the confirmed fee is refused and nothing is written", async () => {
  const taskId = await env.confirmedReturn("C1", kettleReturn);
  await raiseReturnFee(1000);

  const model = await env.runTurn([
    { toolCalls: [{ name: "submit_return", arguments: kettleReturn }] },
    { content: "退货运费有变化，未能提交。" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "FEE_CHANGED", operation: "create_aftersales" },
  });
  expect(await aftersalesOf("C1")).toEqual([]);
  expect(await listWriteIntents(env.db, taskId)).toMatchObject([
    { operation: "create_aftersales", state: "REJECTED" },
  ]);
});

test("after a fee change the original confirmation does not cover the new fee; the customer confirms it again", async () => {
  const taskId = await env.confirmedReturn("C1", kettleReturn);
  await raiseReturnFee(1000);
  const atNewFee = { ...kettleReturn, returnFeeCents: 1000 };

  const rechecking = await env.runTurn([
    { toolCalls: [{ name: "query_aftersales_rules", arguments: { orderId: "O1" } }] },
    { toolCalls: [{ name: "submit_return", arguments: atNewFee }] },
    {
      toolCalls: [
        {
          name: "request_confirmation",
          arguments: {
            tool: "submit_return",
            parameters: atNewFee,
            message: "退货运费已调整为 10 元，请重新确认",
          },
        },
      ],
    },
  ]);
  expect(lastToolResult(rechecking.requests[1])).toMatchObject({ returnFeeCents: 1000 });
  expect(lastToolResult(rechecking.requests[2])).toMatchObject({
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(await listWriteIntents(env.db, taskId)).toEqual([]);

  await confirmLatestRequest(env.db, taskId);
  await env.runTurn([
    { toolCalls: [{ name: "submit_return", arguments: atNewFee }] },
    { content: "退货已提交。" },
  ]);

  expect(await aftersalesOf("C1")).toMatchObject([{ lineId: "L1", returnFeeCents: 1000 }]);
});
