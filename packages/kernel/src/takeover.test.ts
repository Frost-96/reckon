import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  type BusinessPackage,
  createExecutor,
  createScriptedModel,
  createTask,
  defineReadTool,
  type ExecutionDb,
  type ExecutorOptions,
  expireLeases,
  getTask,
  listLeaseEvents,
  listUserVisibleMessages,
  postCustomerMessage,
  readStepLog,
  type ScriptedStep,
} from "./index.ts";
import {
  type ExecutionTestDatabase,
  startExecutionTestDatabase,
  sweepUntilExpired,
} from "./testing.ts";

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

// Stock levels the test controls; records every item looked up.
function stockPackage(stock: Record<string, number>) {
  const lookups: string[] = [];
  const businessPackage: BusinessPackage = {
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
          return { ok: true, value: { sku, units: stock[sku] ?? 0 } };
        },
      }),
    ],
  };
  return { lookups, businessPackage };
}

async function taskWithMessage(content: string): Promise<string> {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, content);
  return task.id;
}

function executor(
  businessPackage: BusinessPackage,
  script: ScriptedStep[],
  options: Partial<ExecutorOptions> & { owner: string },
) {
  const model = createScriptedModel(script);
  return { model, executor: createExecutor({ db, businessPackage, model, ...options }) };
}

test("the watchdog returns a task to READY once its lease has run out by the database clock, for a peer to claim", async () => {
  const taskId = await taskWithMessage("hi");
  const dropped = executor(
    noTools,
    [
      () => {
        throw new Error("executor dropped");
      },
    ],
    { owner: "executor-1", leaseSeconds: 1 },
  );
  await expect(dropped.executor.runOnce()).rejects.toThrow("executor dropped");

  // The holder is gone, but its lease has not run out yet.
  expect(await expireLeases(db)).toEqual([]);
  expect(await getTask(db, taskId)).toMatchObject({ state: "RUNNING", owner: "executor-1" });

  await vi.waitFor(
    async () =>
      expect(await expireLeases(db)).toEqual([{ taskId, owner: "executor-1", version: 1 }]),
    { timeout: 3000, interval: 100 },
  );
  expect(await getTask(db, taskId)).toMatchObject({
    state: "READY",
    owner: null,
    leaseUntil: null,
    version: 1,
  });
  expect(await expireLeases(db)).toEqual([]);

  const peer = executor(noTools, [{ content: "hello" }], { owner: "executor-2" });
  expect(await peer.executor.runOnce()).toEqual({ taskId, result: "waiting_user" });
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER", version: 2 });
});

test("a peer takes over a dropped instance's task and goes on from its step log without calling the model again", async () => {
  const taskId = await taskWithMessage("how many A and B are left?");
  const { lookups, businessPackage } = stockPackage({ A: 3, B: 0 });
  const crash = new Error("executor dropped after reading B");
  let reads = 0;
  const first = executor(
    businessPackage,
    [
      { toolCalls: [{ name: "look_up_stock", arguments: { sku: "A" } }] },
      { toolCalls: [{ name: "look_up_stock", arguments: { sku: "B" } }] },
    ],
    {
      owner: "executor-1",
      leaseSeconds: 0.5,
      heartbeatIntervalMs: 100,
      onFaultPoint(point) {
        if (point.name === "after_read_before_checkpoint" && ++reads === 2) {
          throw crash;
        }
      },
    },
  );
  await expect(first.executor.runOnce()).rejects.toThrow(crash);

  await sweepUntilExpired(db, taskId);
  const peer = executor(businessPackage, [{ content: "3 of A, none of B." }], {
    owner: "executor-2",
  });
  expect(await peer.executor.runOnce()).toEqual({ taskId, result: "waiting_user" });

  // The peer's only model call already carries everything the dropped instance had logged.
  expect(peer.model.requests).toHaveLength(1);
  expect(peer.model.requests[0]?.messages).toEqual([
    { role: "system", content: "You answer stock questions." },
    { role: "user", content: "how many A and B are left?" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_1_1", name: "look_up_stock", arguments: '{"sku":"A"}' }],
    },
    { role: "tool", toolCallId: "call_1_1", content: '{"sku":"A","units":3}' },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_2_1", name: "look_up_stock", arguments: '{"sku":"B"}' }],
    },
    { role: "tool", toolCallId: "call_2_1", content: '{"sku":"B","units":0}' },
  ]);
  // The read whose result was never checkpointed ran again; nothing else did.
  expect(lookups).toEqual(["A", "B", "B"]);
  expect((await readStepLog(db, taskId)).map((step) => [step.kind, step.attempt])).toEqual([
    ["model", 1],
    ["tool", 1],
    ["model", 1],
    ["tool", 2],
    ["model", 2],
  ]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([
    { role: "customer" },
    { role: "agent", content: "3 of A, none of B." },
  ]);
});

test("a takeover leaves lease events stamped by the database clock: expired, claimed, rebuilt, resumed", async () => {
  const taskId = await taskWithMessage("how many A?");
  const { businessPackage } = stockPackage({ A: 3 });
  const crash = new Error("executor dropped after reading A");
  const dropped = executor(
    businessPackage,
    [{ toolCalls: [{ name: "look_up_stock", arguments: { sku: "A" } }] }],
    {
      owner: "executor-1",
      leaseSeconds: 0.5,
      heartbeatIntervalMs: 100,
      onFaultPoint(point) {
        if (point.name === "after_read_before_checkpoint") {
          throw crash;
        }
      },
    },
  );
  await expect(dropped.executor.runOnce()).rejects.toThrow(crash);
  const deadLease = await getTask(db, taskId);
  await sweepUntilExpired(db, taskId);
  await executor(businessPackage, [{ content: "3 left." }], {
    owner: "executor-2",
  }).executor.runOnce();

  const events = await listLeaseEvents(db, taskId);
  expect(events.map(({ kind, owner, version }) => [kind, owner, version])).toEqual([
    ["claimed", "executor-1", 1],
    ["expired", "executor-1", 1],
    ["claimed", "executor-2", 2],
    ["rebuilt", "executor-2", 2],
    ["resumed", "executor-2", 2],
  ]);
  const times = events.map((event) => Number(event.at));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  // Detected by the database clock, so never before the lease ran out.
  expect(times[1]).toBeGreaterThanOrEqual(Number(deadLease?.leaseUntil));
  // The peer took its first step only after it had resumed.
  const firstPeerStep = (await readStepLog(db, taskId)).find((step) => step.attempt === 2);
  expect(Number(firstPeerStep?.createdAt)).toBeGreaterThanOrEqual(times[4] ?? Infinity);

  // A later turn is no recovery: its claim is all it records.
  await postCustomerMessage(db, taskId, "thanks");
  await executor(businessPackage, [{ content: "You're welcome." }], {
    owner: "executor-1",
  }).executor.runOnce();
  const laterEvents = (await listLeaseEvents(db, taskId)).slice(events.length);
  expect(laterEvents).toMatchObject([{ kind: "claimed", owner: "executor-1", version: 3 }]);
});

test("a dropped instance that wakes after the takeover has its checkpoints refused", async () => {
  const taskId = await taskWithMessage("how many A?");
  const { lookups, businessPackage } = stockPackage({ A: 3 });
  let frozen!: () => void;
  let wake!: () => void;
  const reachedFaultPoint = new Promise<void>((resolve) => {
    frozen = resolve;
  });
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  // Stalled at the fault point with its heartbeat stalled too, as under SIGSTOP.
  const zombie = executor(
    businessPackage,
    [
      { toolCalls: [{ name: "look_up_stock", arguments: { sku: "A" } }] },
      { content: "zombie reply" },
    ],
    {
      owner: "executor-1",
      leaseSeconds: 1,
      heartbeatIntervalMs: 60_000,
      async onFaultPoint(point) {
        if (point.name === "after_read_before_checkpoint") {
          frozen();
          await woken;
        }
      },
    },
  );
  const zombieTurn = zombie.executor.runOnce();
  await reachedFaultPoint;

  await sweepUntilExpired(db, taskId);
  const peer = executor(businessPackage, [{ content: "3 left." }], { owner: "executor-2" });
  expect(await peer.executor.runOnce()).toEqual({ taskId, result: "waiting_user" });
  wake();

  expect(await zombieTurn).toEqual({ taskId, result: "lease_lost" });
  expect(lookups).toEqual(["A", "A"]);
  expect((await readStepLog(db, taskId)).map((step) => [step.kind, step.attempt])).toEqual([
    ["model", 1],
    ["tool", 2],
    ["model", 2],
  ]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([
    { role: "customer" },
    { role: "agent", content: "3 left." },
  ]);
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER", version: 2 });
});
