import { afterAll, beforeAll, expect, test, vi } from "vitest";
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
  modelToolDefinitions,
  postCustomerMessage,
  readStepLog,
  type ScriptedStep,
  type ToolDeclaration,
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

const noTools: BusinessPackage = { systemPrompt: "You are a test agent.", tools: [] };

// A domain-neutral stand-in for a business package: stock levels the test controls.
function stockPackage(stock: Record<string, number>): BusinessPackage {
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
          const units = stock[sku];
          return units === undefined
            ? { ok: false, error: { code: "UNKNOWN_SKU", message: `No item ${sku}` } }
            : { ok: true, value: { sku, units } };
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

test("a customer message makes the task READY and the agent's reply hands it back to the customer", async () => {
  const task = await createTask(db, { customerId: "C1" });
  expect(task.state).toBe("WAITING_USER");

  await postCustomerMessage(db, task.id, "hello");
  expect((await getTask(db, task.id))?.state).toBe("READY");

  await runTurnWith(noTools, [{ content: "hi, how can I help?" }]);

  expect(await getTask(db, task.id)).toMatchObject({ state: "WAITING_USER", owner: null });
  expect(await listUserVisibleMessages(db, task.id)).toMatchObject([
    { turn: 1, seq: 0, role: "customer", content: "hello" },
    { turn: 1, seq: 1, role: "agent", content: "hi, how can I help?" },
  ]);
});

test("the tool calls of one model response run one by one in the order returned, one step each", async () => {
  const taskId = await taskWithMessage("how many A and B are left?");

  const { model } = await runTurnWith(stockPackage({ A: 3, B: 0 }), [
    {
      toolCalls: [
        { name: "look_up_stock", arguments: { sku: "A" } },
        { name: "look_up_stock", arguments: { sku: "B" } },
      ],
    },
    { content: "3 of A, none of B." },
  ]);

  const log = await readStepLog(db, taskId);
  expect(log.map((step) => [step.seq, step.kind, step.status])).toEqual([
    [1, "model", "ok"],
    [2, "tool", "ok"],
    [3, "tool", "ok"],
    [4, "model", "ok"],
  ]);
  expect(model.requests[1]?.messages.slice(-2)).toEqual([
    { role: "tool", toolCallId: "call_1_1", content: '{"sku":"A","units":3}' },
    { role: "tool", toolCallId: "call_1_2", content: '{"sku":"B","units":0}' },
  ]);
  expect((await listUserVisibleMessages(db, taskId)).at(-1)).toMatchObject({
    role: "agent",
    content: "3 of A, none of B.",
  });
});

test("the next turn appends to the step log, and the model sees earlier turns rebuilt from it", async () => {
  const taskId = await taskWithMessage("how many A?");
  await runTurnWith(stockPackage({ A: 3 }), [
    { toolCalls: [{ name: "look_up_stock", arguments: { sku: "A" } }] },
    { content: "3 left." },
  ]);
  const firstTurnLog = await readStepLog(db, taskId);

  await postCustomerMessage(db, taskId, "and now?");
  const { model } = await runTurnWith(stockPackage({ A: 2 }), [{ content: "Still about 3." }]);

  const log = await readStepLog(db, taskId);
  expect(log.slice(0, firstTurnLog.length)).toEqual(firstTurnLog);
  expect(log.slice(firstTurnLog.length).map((step) => [step.seq, step.turn, step.kind])).toEqual([
    [4, 2, "model"],
  ]);
  expect(model.requests[0]?.messages).toEqual([
    { role: "system", content: "You answer stock questions." },
    { role: "user", content: "how many A?" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_1_1", name: "look_up_stock", arguments: '{"sku":"A"}' }],
    },
    { role: "tool", toolCallId: "call_1_1", content: '{"sku":"A","units":3}' },
    { role: "assistant", content: "3 left.", toolCalls: [] },
    { role: "user", content: "and now?" },
  ]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([
    { turn: 1, seq: 0, role: "customer" },
    { turn: 1, seq: 3, role: "agent", content: "3 left." },
    { turn: 2, seq: 0, role: "customer" },
    // An agent message takes the seq of the step that produced it.
    { turn: 2, seq: 4, role: "agent", content: "Still about 3." },
  ]);
});

test("the database refuses to change or remove a logged step", async () => {
  const taskId = await taskWithMessage("hello");
  await runTurnWith(noTools, [{ content: "hi" }]);

  await expect(
    database.pool.query("UPDATE steps SET status = 'error' WHERE task_id = $1", [taskId]),
  ).rejects.toThrow(/append-only/);
  await expect(
    database.pool.query("DELETE FROM steps WHERE task_id = $1", [taskId]),
  ).rejects.toThrow(/append-only/);
  expect(await readStepLog(db, taskId)).toMatchObject([{ seq: 1, kind: "model", status: "ok" }]);
});

test.each([
  ["an unknown tool", { name: "drop_tables", arguments: {} }, "UNKNOWN_TOOL"],
  ["malformed JSON", { name: "look_up_stock", arguments: '{"sku":' }, "INVALID_ARGUMENTS"],
  [
    "arguments off the schema",
    { name: "look_up_stock", arguments: { sku: 7 } },
    "INVALID_ARGUMENTS",
  ],
  ["an error the tool reports", { name: "look_up_stock", arguments: { sku: "Z" } }, "UNKNOWN_SKU"],
])(
  "a tool call with %s is answered with a structured error the model sees",
  async (_case, call, code) => {
    const taskId = await taskWithMessage("how many Z?");

    const { model } = await runTurnWith(stockPackage({ A: 3 }), [
      { toolCalls: [call] },
      { content: "Sorry, I could not look that up." },
    ]);

    const toolStep = (await readStepLog(db, taskId))[1];
    expect(toolStep).toMatchObject({ kind: "tool", status: "error", output: { error: { code } } });
    const toolMessage = model.requests[1]?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "call_1_1" });
    expect(JSON.parse(toolMessage?.role === "tool" ? toolMessage.content : "")).toMatchObject({
      error: { code },
    });
  },
);

test.each([
  [
    "two tools of one name",
    (tool: ToolDeclaration) => [tool, tool],
    /look_up_stock.*more than once/,
  ],
  [
    "a read tool that does not declare its volatility",
    (tool: ToolDeclaration) => [{ ...tool, volatility: undefined } as unknown as ToolDeclaration],
    /look_up_stock.*volatility/,
  ],
  [
    "a tool named like a kernel built-in",
    (tool: ToolDeclaration) => [{ ...tool, name: "ask_user" }],
    /ask_user.*reserved/,
  ],
])("a business package with %s is refused", (_case, tools, message) => {
  const [tool] = stockPackage({}).tools;
  if (tool === undefined) {
    throw new Error("stock package has no tool");
  }
  const businessPackage = { systemPrompt: "", tools: tools(tool) };

  expect(() =>
    createExecutor({ db, owner: "executor-1", businessPackage, model: createScriptedModel([]) }),
  ).toThrow(message);
});

test("the model is offered the business package's tools with their parameter schemas, then the kernel's", async () => {
  await taskWithMessage("anything left?");

  const { model } = await runTurnWith(stockPackage({}), [{ content: "Which item?" }]);

  expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(["look_up_stock", "ask_user"]);
  expect(model.requests[0]?.tools.slice(0, 1)).toEqual([
    {
      name: "look_up_stock",
      description: "Current stock of one item",
      parameters: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
    },
  ]);
});

// What a freeze hashes has to be exactly what the model is sent.
test("the tool definitions published for a business package are the ones its model requests carry", async () => {
  await taskWithMessage("anything left?");

  const { model } = await runTurnWith(stockPackage({}), [{ content: "Which item?" }]);

  expect(modelToolDefinitions(stockPackage({}))).toEqual(model.requests[0]?.tools);
});

test("a started executor serves tasks as customer messages arrive, until stopped", async () => {
  const failing: BusinessPackage = {
    systemPrompt: "",
    tools: [
      defineReadTool({
        kind: "read",
        name: "explode",
        description: "Fails unexpectedly",
        parameters: z.object({}),
        volatility: "stable",
        async run() {
          throw new Error("boom");
        },
      }),
    ],
  };
  const errors: unknown[] = [];
  const worker = createExecutor({
    db,
    owner: "executor-1",
    businessPackage: failing,
    model: createScriptedModel([
      { toolCalls: [{ name: "explode", arguments: {} }] },
      { content: "served" },
    ]),
    pollIntervalMs: 20,
    onError: (error) => errors.push(error),
  });

  worker.start();
  try {
    const crashedTaskId = await taskWithMessage("first");
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 2000 });
    const servedTaskId = await taskWithMessage("second");
    await vi.waitFor(
      async () => expect((await getTask(db, servedTaskId))?.state).toBe("WAITING_USER"),
      { timeout: 2000 },
    );
    // The failed turn keeps its lease until it expires, as if the executor had crashed.
    expect((await getTask(db, crashedTaskId))?.state).toBe("RUNNING");
  } finally {
    await worker.stop();
  }
  const afterStop = await taskWithMessage("third");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await getTask(db, afterStop))?.state).toBe("READY");
});
