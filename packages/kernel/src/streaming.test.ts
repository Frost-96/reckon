import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  type BusinessPackage,
  createExecutor,
  createScriptedModel,
  createTask,
  type ExecutionDb,
  type ExecutorOptions,
  listenForTaskNotifications,
  listUserVisibleMessages,
  postCustomerMessage,
  readStepLog,
  type ScriptedStep,
  type TaskNotification,
  type TaskNotificationListener,
} from "./index.ts";
import {
  type ExecutionTestDatabase,
  startExecutionTestDatabase,
  sweepUntilExpired,
} from "./testing.ts";

let database: ExecutionTestDatabase;
let db: ExecutionDb;
let listener: TaskNotificationListener;
const notifications: TaskNotification[] = [];

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  db = database.db;
  listener = await listenForTaskNotifications(database.pool, {
    onNotification: (notification) => notifications.push(notification),
    onError: (error) => console.error(error),
    onLost: (error) => console.error(error),
  });
});

afterAll(async () => {
  await listener.stop();
  await database.close();
});

const noTools: BusinessPackage = { systemPrompt: "You are a test agent.", tools: [] };

function notificationsOf(taskId: string): TaskNotification[] {
  return notifications.filter((notification) => notification.taskId === taskId);
}

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

function draftsOf(taskId: string): TaskNotification[] {
  return notificationsOf(taskId).filter((notification) => notification.kind === "draft");
}

test("the agent's reply goes out as draft fragments carrying task, step and attempt, then as the written message", async () => {
  const taskId = await taskWithMessage("hi");

  await executor([{ content: "您好，请问是哪一笔订单？" }]).runOnce();

  const draft = { kind: "draft", taskId, turn: 1, step: 1, attempt: 1 };
  await vi.waitFor(() =>
    expect(notificationsOf(taskId)).toEqual([
      { kind: "message", taskId, turn: 1, seq: 0 },
      { ...draft, index: 0, text: "您好，请" },
      { ...draft, index: 1, text: "问是哪一" },
      { ...draft, index: 2, text: "笔订单？" },
      { kind: "message", taskId, turn: 1, seq: 1 },
    ]),
  );
});

test("while the reply is still streaming only drafts are out: neither its step nor its message is written", async () => {
  const taskId = await taskWithMessage("hi");
  let reachMidway = () => {};
  const midway = new Promise<void>((resolve) => {
    reachMidway = resolve;
  });
  let resume = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });

  const turn = executor([{ content: "您好，请问是哪一笔订单？" }], {
    async onFaultPoint(point) {
      if (point.name === "mid_model_stream") {
        reachMidway();
        await held;
      }
    },
  }).runOnce();
  await midway;

  await vi.waitFor(() =>
    expect(draftsOf(taskId)).toEqual([
      { kind: "draft", taskId, turn: 1, step: 1, attempt: 1, index: 0, text: "您好，请" },
    ]),
  );
  expect(await readStepLog(db, taskId)).toEqual([]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([{ role: "customer" }]);

  resume();
  expect(await turn).toEqual({ taskId, result: "waiting_user" });
  expect(await readStepLog(db, taskId)).toMatchObject([
    { seq: 1, kind: "model", attempt: 1, output: { content: "您好，请问是哪一笔订单？" } },
  ]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([
    { role: "customer" },
    { role: "agent", seq: 1, content: "您好，请问是哪一笔订单？" },
  ]);
});

test("a crash mid-stream leaves only drafts behind; the peer calls the model again under a new attempt and the reply is written once", async () => {
  const taskId = await taskWithMessage("hi");
  const reply = "您好，请问是哪一笔订单？";
  const crashed = executor([{ content: reply }], {
    leaseSeconds: 0.5,
    onFaultPoint(point) {
      if (point.name === "mid_model_stream") {
        throw new Error("executor dropped mid-stream");
      }
    },
  });
  await expect(crashed.runOnce()).rejects.toThrow("executor dropped mid-stream");
  await sweepUntilExpired(db, taskId);

  const peer = executor([{ content: reply }], { owner: "executor-2" });
  expect(await peer.runOnce()).toEqual({ taskId, result: "waiting_user" });

  const draft = { kind: "draft", taskId, turn: 1, step: 1 };
  await vi.waitFor(() =>
    expect(notificationsOf(taskId)).toEqual([
      { kind: "message", taskId, turn: 1, seq: 0 },
      { ...draft, attempt: 1, index: 0, text: "您好，请" },
      { ...draft, attempt: 2, index: 0, text: "您好，请" },
      { ...draft, attempt: 2, index: 1, text: "问是哪一" },
      { ...draft, attempt: 2, index: 2, text: "笔订单？" },
      { kind: "message", taskId, turn: 1, seq: 1 },
    ]),
  );
  expect(await readStepLog(db, taskId)).toMatchObject([
    { seq: 1, kind: "model", attempt: 2, output: { content: reply } },
  ]);
  expect(await listUserVisibleMessages(db, taskId)).toMatchObject([
    { role: "customer" },
    { role: "agent", seq: 1, content: reply },
  ]);
});
