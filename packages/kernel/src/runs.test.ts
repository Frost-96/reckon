import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import {
  type BusinessPackage,
  createExecutor,
  createRun,
  createTask,
  defineReadTool,
  type ExecutionDb,
  listUserVisibleMessages,
  modelOfRun,
  postCustomerMessage,
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

const stockPackage: BusinessPackage = {
  systemPrompt: "You answer stock questions.",
  tools: [
    defineReadTool({
      kind: "read",
      name: "look_up_stock",
      description: "Current stock of one item",
      parameters: z.object({ sku: z.string() }),
      volatility: "volatile",
      async run({ sku }) {
        return { ok: true, value: { sku, units: 3 } };
      },
    }),
  ],
};

function executor(owner: string) {
  return createExecutor({ db, owner, businessPackage: stockPackage, model: modelOfRun(db) });
}

test("a task in a run is answered from the script its run brings, whichever executor serves the turn", async () => {
  const run = await createRun(db, {
    scenario: "stock-question",
    config: {
      model: {
        kind: "scripted",
        turns: [
          [
            { toolCalls: [{ name: "look_up_stock", arguments: { sku: "kettle" } }] },
            { content: "水壶还有 3 件。" },
          ],
          [{ content: "不客气。" }],
        ],
      },
    },
  });
  const task = await createTask(db, { customerId: "C1", runId: run.id });

  await postCustomerMessage(db, task.id, "水壶还有货吗？");
  await executor("executor-1").runOnce();
  // A fresh executor, as after a restart: the script position comes from the task, not memory.
  await postCustomerMessage(db, task.id, "谢谢");
  await executor("executor-2").runOnce();

  expect(await listUserVisibleMessages(db, task.id)).toMatchObject([
    { turn: 1, role: "customer", content: "水壶还有货吗？" },
    { turn: 1, role: "agent", content: "水壶还有 3 件。" },
    { turn: 2, role: "customer", content: "谢谢" },
    { turn: 2, role: "agent", content: "不客气。" },
  ]);
});
