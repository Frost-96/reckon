import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  appendUserVisibleMessage,
  closeTask,
  createTask,
  type ExecutionDb,
  getTask,
  listUserVisibleMessages,
  postCustomerMessage,
  RunNotFoundError,
  TaskNotFoundError,
  TaskNotWaitingForCustomerError,
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

test("a user-visible message written again under the same task, turn and seq is kept once", async () => {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, "hello");

  await appendUserVisibleMessage(db, {
    taskId: task.id,
    turn: 1,
    seq: 1,
    role: "agent",
    content: "hi",
  });
  await appendUserVisibleMessage(db, {
    taskId: task.id,
    turn: 1,
    seq: 1,
    role: "agent",
    content: "hi again",
  });

  expect(await listUserVisibleMessages(db, task.id)).toMatchObject([
    { turn: 1, seq: 0, role: "customer", content: "hello" },
    { turn: 1, seq: 1, role: "agent", content: "hi" },
  ]);
});

test("a customer message is refused while the task is not waiting for the customer", async () => {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, "first");

  await expect(postCustomerMessage(db, task.id, "second")).rejects.toBeInstanceOf(
    TaskNotWaitingForCustomerError,
  );
  expect(await listUserVisibleMessages(db, task.id)).toMatchObject([{ content: "first" }]);
});

test("a customer message to an unknown task is refused", async () => {
  await expect(postCustomerMessage(db, randomUUID(), "hello")).rejects.toBeInstanceOf(
    TaskNotFoundError,
  );
});

test("a customer ends the session while it waits for them, and the closed task takes no more messages", async () => {
  const task = await createTask(db, { customerId: "C1" });

  expect(await closeTask(db, task.id)).toMatchObject({ id: task.id, state: "CLOSED" });

  expect((await getTask(db, task.id))?.state).toBe("CLOSED");
  await expect(postCustomerMessage(db, task.id, "还在吗？")).rejects.toBeInstanceOf(
    TaskNotWaitingForCustomerError,
  );
  // Ending it again (e.g. a retried request) changes nothing.
  expect(await closeTask(db, task.id)).toMatchObject({ state: "CLOSED" });
});

test("a session cannot be ended while the agent is working on its turn", async () => {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, "我想退货");

  await expect(closeTask(db, task.id)).rejects.toBeInstanceOf(TaskNotWaitingForCustomerError);
  expect((await getTask(db, task.id))?.state).toBe("READY");
  await expect(closeTask(db, randomUUID())).rejects.toBeInstanceOf(TaskNotFoundError);
});

test("a task cannot name a run that does not exist", async () => {
  await expect(createTask(db, { customerId: "C1", runId: randomUUID() })).rejects.toBeInstanceOf(
    RunNotFoundError,
  );
});
