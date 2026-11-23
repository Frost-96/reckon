import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import {
  type BusinessPackage,
  createExecutor,
  createScriptedModel,
  createTask,
  defineReadTool,
  type ExecutionDb,
  getTask,
  listUserVisibleMessages,
  postCustomerMessage,
  readStepLog,
  type ScriptedStep,
} from "./index.ts";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "./testing.ts";

let database: ExecutionTestDatabase;
let db: ExecutionDb;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.close();
});

// A read tool that records every lookup it actually performs.
function stockPackage(lookups: string[]): BusinessPackage {
  return {
    systemPrompt: "You answer stock questions.",
    tools: [
      defineReadTool({
        kind: "read",
        name: "look_up_stock",
        description: "Current stock of one item",
        parameters: z.object({ sku: z.string() }),
        volatility: "volatile",
        async run({ sku }) {
          lookups.push(sku);
          return { ok: true, value: { sku, units: 3 } };
        },
      }),
    ],
  };
}

async function taskWithMessage(content: string): Promise<string> {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, content);
  return task.id;
}

async function runTurnWith(businessPackage: BusinessPackage, script: ScriptedStep[]) {
  const model = createScriptedModel(script);
  const executor = createExecutor({ db, owner: "executor-1", businessPackage, model });
  const outcome = await executor.runOnce();
  return { model, outcome };
}

test("ask_user ends the turn with the question to the customer; later calls of the response do not run", async () => {
  const lookups: string[] = [];
  const taskId = await taskWithMessage("is it in stock?");

  const { model, outcome } = await runTurnWith(stockPackage(lookups), [
    {
      toolCalls: [
        {
          name: "ask_user",
          arguments: { question: "Which item?", slot: "sku", options: ["A", "B"] },
        },
        { name: "look_up_stock", arguments: { sku: "A" } },
        { name: "look_up_stock", arguments: { sku: "B" } },
      ],
    },
  ]);

  expect(outcome).toEqual({ taskId, result: "waiting_user" });
  expect(lookups).toEqual([]);
  expect(model.requests).toHaveLength(1);
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER", owner: null });
  expect((await listUserVisibleMessages(db, taskId)).at(-1)).toMatchObject({
    turn: 1,
    role: "agent",
    content: "Which item?",
    payload: { kind: "question", slot: "sku", options: ["A", "B"] },
  });
  const log = await readStepLog(db, taskId);
  expect(log.map((step) => [step.seq, step.kind, step.status])).toEqual([
    [1, "model", "ok"],
    [2, "tool", "ok"],
    [3, "tool", "error"],
    [4, "tool", "error"],
  ]);
  for (const skipped of log.slice(2)) {
    expect(skipped).toMatchObject({
      input: { name: "look_up_stock" },
      output: { error: { code: "NOT_EXECUTED", message: "未执行：本轮已转为等待用户" } },
    });
  }
});
