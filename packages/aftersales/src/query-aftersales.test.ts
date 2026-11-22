import { getTask, listWriteIntents, postCustomerMessage } from "@reckon/kernel";
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

const kettleReturn = {
  orderId: "O1",
  lineId: "L1",
  quantity: 1,
  reason: "尺寸不合适",
  returnFeeCents: 800,
};

interface SubmittedReturn {
  create_aftersales: { id: string };
  create_return_shipment: { id: string };
}

test("after the return, the customer asks in the same task and the agent reads back the new aftersales order and return shipment", async () => {
  const taskId = await env.confirmedReturn("C1", kettleReturn);
  const submitting = await env.runTurn([
    { toolCalls: [{ name: "submit_return", arguments: kettleReturn }] },
    { content: "退货已提交。" },
  ]);
  const submitted = lastToolResult(submitting.requests[1]) as SubmittedReturn;
  expect((await getTask(env.db, taskId))?.state).toBe("WAITING_USER");

  await postCustomerMessage(env.db, taskId, "我的退货办到哪一步了？");
  const asking = await env.runTurn([
    { toolCalls: [{ name: "query_aftersales", arguments: { orderId: "O1" } }] },
    { content: "售后单已受理，寄回单也已生成。" },
  ]);

  const [aftersalesIntent, shipmentIntent] = await listWriteIntents(env.db, taskId);
  expect(lastToolResult(asking.requests[1])).toMatchObject({
    aftersales: [
      {
        id: submitted.create_aftersales.id,
        orderId: "O1",
        lineId: "L1",
        status: "in_progress",
        clientRef: aftersalesIntent?.operationId,
        returnShipment: {
          id: submitted.create_return_shipment.id,
          clientRef: shipmentIntent?.operationId,
        },
      },
    ],
  });
});
