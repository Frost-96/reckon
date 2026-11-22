import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  appendUserVisibleMessage,
  createTask,
  type ExecutionDb,
  listUserVisibleMessages,
  postCustomerMessage,
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
