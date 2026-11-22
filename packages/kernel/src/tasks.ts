import { asc, eq, sql } from "drizzle-orm";
import type { ExecutionDb, ExecutionQueries } from "./db/database.ts";
import { type messageRoles, type taskStates, tasks, userVisibleMessages } from "./db/schema.ts";

export type TaskState = (typeof taskStates)[number];
export type Task = typeof tasks.$inferSelect;

export type MessageRole = (typeof messageRoles)[number];
export interface UserVisibleMessage {
  taskId: string;
  turn: number;
  seq: number;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export class TaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class TaskNotWaitingForCustomerError extends Error {
  readonly taskId: string;
  readonly state: TaskState;

  constructor(taskId: string, state: TaskState) {
    super(`Task ${taskId} is ${state}, not waiting for the customer`);
    this.name = "TaskNotWaitingForCustomerError";
    this.taskId = taskId;
    this.state = state;
  }
}

// A new task waits for the customer's first message.
export async function createTask(db: ExecutionDb, input: { customerId: string }): Promise<Task> {
  const [task] = await db
    .insert(tasks)
    .values({ customerId: input.customerId, state: "WAITING_USER" })
    .returning();
  if (task === undefined) {
    throw new Error("Task insert returned no row");
  }
  return task;
}

export async function getTask(db: ExecutionQueries, taskId: string): Promise<Task | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return task;
}

// Starts the next turn with the customer's message and queues the task for an executor.
export async function postCustomerMessage(
  db: ExecutionDb,
  taskId: string,
  content: string,
): Promise<{ turn: number }> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    if (task.state !== "WAITING_USER") {
      throw new TaskNotWaitingForCustomerError(taskId, task.state);
    }
    const turn = task.turn + 1;
    await appendUserVisibleMessage(tx, { taskId, turn, seq: 0, role: "customer", content });
    await tx
      .update(tasks)
      .set({ state: "READY", turn, updatedAt: sql`now()` })
      .where(eq(tasks.id, taskId));
    return { turn };
  });
}

// Keyed by (task, turn, seq): writing the same message again is ignored.
export async function appendUserVisibleMessage(
  db: ExecutionQueries,
  message: Omit<UserVisibleMessage, "createdAt">,
): Promise<void> {
  await db.insert(userVisibleMessages).values(message).onConflictDoNothing();
}

export async function listUserVisibleMessages(
  db: ExecutionQueries,
  taskId: string,
): Promise<UserVisibleMessage[]> {
  return db
    .select()
    .from(userVisibleMessages)
    .where(eq(userVisibleMessages.taskId, taskId))
    .orderBy(asc(userVisibleMessages.turn), asc(userVisibleMessages.seq));
}
