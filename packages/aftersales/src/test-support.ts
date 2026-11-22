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
  type ScriptedModel,
  type ScriptedStep,
} from "@reckon/kernel";
import { startExecutionTestDatabase } from "@reckon/kernel/testing";
import { createAftersalesPackage } from "./index.ts";

// The aftersales package run by the real kernel against a business mock over HTTP.
export interface AftersalesUnderTest {
  mock: BusinessMockUnderTest;
  db: ExecutionDb;
  // Runs the next ready turn with a fresh executor whose model answers from the script.
  runTurn(script: ScriptedStep[]): Promise<ScriptedModel>;
  // Turn 1 asks the customer to confirm a return; the customer confirms, starting turn 2.
  confirmedReturn(customerId: string, parameters: unknown): Promise<string>;
  close(): Promise<void>;
}

export async function startAftersalesUnderTest(
  options: { now?: () => Date } = {},
): Promise<AftersalesUnderTest> {
  const mock = await startBusinessMock(options);
  await mock.app.listen({ host: "127.0.0.1", port: 0 });
  const businessServiceUrl = `http://127.0.0.1:${(mock.app.server.address() as AddressInfo).port}`;
  const database = await startExecutionTestDatabase();
  const { db } = database;

  async function runTurn(script: ScriptedStep[]): Promise<ScriptedModel> {
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

  return {
    mock,
    db,
    runTurn,
    async confirmedReturn(customerId, parameters) {
      const task = await createTask(db, { customerId });
      await postCustomerMessage(db, task.id, "我要退货");
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
      await confirmLatestRequest(db, task.id);
      return task.id;
    },
    async close() {
      await database.close();
      await mock.close();
    },
  };
}

// The customer confirms the confirmation request in the task's latest agent message.
export async function confirmLatestRequest(db: ExecutionDb, taskId: string): Promise<void> {
  const request = (await listUserVisibleMessages(db, taskId)).at(-1);
  if (request?.payload?.kind !== "confirmation_request") {
    throw new Error("The agent did not ask for confirmation");
  }
  await postCustomerMessage(db, taskId, "确认", { confirms: request.seq });
}

export function lastToolResult(request: ModelRequest | undefined): unknown {
  const message = request?.messages.at(-1);
  if (message?.role !== "tool") {
    throw new Error("The request does not end with a tool result");
  }
  return JSON.parse(message.content);
}
