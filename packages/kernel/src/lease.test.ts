import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  type BusinessPackage,
  createExecutor,
  createScriptedModel,
  createTask,
  type ExecutionDb,
  type ExecutorOptions,
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

const noTools: BusinessPackage = { systemPrompt: "You are a test agent.", tools: [] };

async function taskWithMessage(content: string): Promise<string> {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, content);
  return task.id;
}

function executor(script: ScriptedStep[], options: Partial<ExecutorOptions> = {}) {
  return createExecutor({
    db,
    owner: "executor-1",
    businessPackage: noTools,
    model: createScriptedModel(script),
    ...options,
  });
}

// A model step that stays open until released, to look at the task mid-turn.
function heldStep(response: { content: string } = { content: "ok" }) {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: ScriptedStep = async () => {
    entered();
    await released;
    return response;
  };
  return { step, entered: enteredPromise, release };
}

test("a claim records the owner, bumps the version and sets the lease on the database clock", async () => {
  const taskId = await taskWithMessage("hi");
  const held = heldStep();

  const turn = executor([held.step], { leaseSeconds: 10 }).runOnce();
  await held.entered;
  const claimed = await getTask(db, taskId);
  held.release();
  await turn;

  expect(claimed).toMatchObject({ state: "RUNNING", owner: "executor-1", version: 1 });
  // updatedAt is the claim statement's now(), so the lease is exactly now() + 10s.
  expect(Number(claimed?.leaseUntil) - Number(claimed?.updatedAt)).toBe(10_000);

  await postCustomerMessage(db, taskId, "again");
  await executor([{ content: "ok" }], { owner: "executor-2" }).runOnce();
  expect(await getTask(db, taskId)).toMatchObject({
    state: "WAITING_USER",
    owner: null,
    leaseUntil: null,
    version: 2,
  });
});

test("heartbeats keep renewing the lease while a step is still running", async () => {
  const taskId = await taskWithMessage("slow one");
  const held = heldStep();

  const turn = executor([held.step], { leaseSeconds: 1, heartbeatIntervalMs: 100 }).runOnce();
  await held.entered;
  const initialLeaseUntil = Number((await getTask(db, taskId))?.leaseUntil);
  // Past the original 1s lease, with no step logged in between.
  await vi.waitFor(
    async () => {
      const leaseUntil = Number((await getTask(db, taskId))?.leaseUntil);
      expect(leaseUntil).toBeGreaterThan(initialLeaseUntil + 1000);
    },
    { timeout: 3000, interval: 50 },
  );
  held.release();

  expect(await turn).toEqual({ taskId, result: "waiting_user" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER", leaseUntil: null });
});

test("a checkpoint under a version that has moved on is rejected as a whole", async () => {
  const taskId = await taskWithMessage("hi");
  const held = heldStep({ content: "stale reply" });

  const turn = executor([held.step]).runOnce();
  await held.entered;
  // Stand-in for a takeover (watchdog + peer claim arrive with #8): same owner name, as after
  // a restart, so only the version tells the two holders apart.
  await database.pool.query("UPDATE tasks SET version = version + 1 WHERE id = $1", [taskId]);
  held.release();

  expect(await turn).toEqual({ taskId, result: "lease_lost" });
  expect(await readStepLog(db, taskId)).toEqual([]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([{ role: "customer" }]);
  expect(await getTask(db, taskId)).toMatchObject({ state: "RUNNING", version: 2 });
});

test("a heartbeat that finds the lease gone abandons the step still in flight", async () => {
  const taskId = await taskWithMessage("hi");
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const untilAborted: ScriptedStep = async (_request, { signal }) => {
    entered();
    await new Promise((resolve) => signal?.addEventListener("abort", resolve));
    return { content: "never sent" };
  };

  const turn = executor([untilAborted], { heartbeatIntervalMs: 100 }).runOnce();
  await enteredPromise;
  await database.pool.query("UPDATE tasks SET version = version + 1 WHERE id = $1", [taskId]);

  expect(await turn).toEqual({ taskId, result: "lease_lost" });
  expect(await readStepLog(db, taskId)).toEqual([]);
});

test("a checkpoint after the lease ran out on the database clock is rejected", async () => {
  const taskId = await taskWithMessage("hi");
  const held = heldStep({ content: "late reply" });

  const turn = executor([held.step], { leaseSeconds: 1, heartbeatIntervalMs: 60_000 }).runOnce();
  await held.entered;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  held.release();

  expect(await turn).toEqual({ taskId, result: "lease_lost" });
  expect(await readStepLog(db, taskId)).toEqual([]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([{ role: "customer" }]);
});

test("an executor holds at most one task's lease at a time", async () => {
  const firstTaskId = await taskWithMessage("one");
  const secondTaskId = await taskWithMessage("two");
  const held = heldStep();
  const worker = executor([held.step, { content: "ok" }]);

  const turns = Promise.all([worker.runOnce(), worker.runOnce()]);
  await held.entered;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const secondWhileFirstRuns = await getTask(db, secondTaskId);
  held.release();

  expect(secondWhileFirstRuns?.state).toBe("READY");
  expect(await turns).toEqual([
    { taskId: firstTaskId, result: "waiting_user" },
    { taskId: secondTaskId, result: "waiting_user" },
  ]);
});

test("executors claiming side by side never take the same task", async () => {
  const taskIds = [];
  for (let i = 0; i < 6; i++) {
    taskIds.push(await taskWithMessage(`message ${i}`));
  }
  async function drain(owner: string): Promise<string[]> {
    const worker = executor(Array(taskIds.length).fill({ content: `from ${owner}` }), { owner });
    const claimed: string[] = [];
    for (let outcome = await worker.runOnce(); outcome; outcome = await worker.runOnce()) {
      claimed.push(outcome.taskId);
    }
    return claimed;
  }

  const [byA, byB] = await Promise.all([drain("executor-a"), drain("executor-b")]);

  expect([...byA, ...byB].sort()).toEqual([...taskIds].sort());
  for (const taskId of taskIds) {
    const replies = (await listUserVisibleMessages(db, taskId)).filter((m) => m.role === "agent");
    expect(replies).toHaveLength(1);
  }
});

test("a claim takes a READY task another claimer has locked by skipping it", async () => {
  const lockedTaskId = await taskWithMessage("first");
  const nextTaskId = await taskWithMessage("second");
  const competitor = await database.pool.connect();
  try {
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [lockedTaskId]);

    const outcome = await executor([{ content: "ok" }]).runOnce();

    expect(outcome?.taskId).toBe(nextTaskId);
  } finally {
    await competitor.query("ROLLBACK");
    competitor.release();
  }
  expect((await executor([{ content: "ok" }]).runOnce())?.taskId).toBe(lockedTaskId);
});
