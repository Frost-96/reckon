import { asc, eq, sql } from "drizzle-orm";
import { confirmByCustomer } from "./confirmations.ts";
import type { ExecutionDb, ExecutionQueries } from "./db/database.ts";
import { type messageRoles, type taskStates, tasks, userVisibleMessages } from "./db/schema.ts";
import { getRun, RunNotFoundError } from "./runs.ts";

export type TaskState = (typeof taskStates)[number];
export type Task = typeof tasks.$inferSelect;

export type MessageRole = (typeof messageRoles)[number];

// The structured part of a message, beyond its text.
export type MessagePayload =
  // Agent: what the customer is asked to fill in.
  | { kind: "question"; slot: string; options?: string[] }
  // Agent: the normalized parameters the customer is asked to confirm.
  | { kind: "confirmation_request"; tool: string; parameters: unknown }
  // Customer: confirms the request shown in the agent message with this seq.
  | { kind: "confirmation"; seq: number; tool: string; parameters: unknown };

export interface UserVisibleMessage {
  taskId: string;
  turn: number;
  // Customer messages are 0; an agent message takes the seq of the step that produced it.
  seq: number;
  role: MessageRole;
  content: string;
  payload: MessagePayload | null;
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

// A new task waits for the customer's first message. A task of an experiment run names it.
export async function createTask(
  db: ExecutionDb,
  input: { customerId: string; runId?: string },
): Promise<Task> {
  // Runs are never deleted, so one found here is still there at the insert.
  if (input.runId !== undefined && (await getRun(db, input.runId)) === undefined) {
    throw new RunNotFoundError(input.runId);
  }
  const [task] = await db
    .insert(tasks)
    .values({ customerId: input.customerId, runId: input.runId ?? null, state: "WAITING_USER" })
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

export class ConfirmationNotPendingError extends Error {
  readonly taskId: string;
  readonly seq: number;

  constructor(taskId: string, seq: number) {
    super(`Task ${taskId} has no confirmation request ${seq} waiting for the customer`);
    this.name = "ConfirmationNotPendingError";
    this.taskId = taskId;
    this.seq = seq;
  }
}

export interface CustomerMessageOptions {
  // The seq of the agent message whose confirmation request this message confirms.
  confirms?: number;
}

// Starts the next turn with the customer's message and queues the task for an executor.
export async function postCustomerMessage(
  db: ExecutionDb,
  taskId: string,
  content: string,
  options: CustomerMessageOptions = {},
): Promise<{ turn: number }> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    if (task.state !== "WAITING_USER") {
      throw new TaskNotWaitingForCustomerError(taskId, task.state);
    }
    let payload: MessagePayload | undefined;
    if (options.confirms !== undefined) {
      const confirmed = await confirmByCustomer(tx, taskId, options.confirms);
      if (confirmed === undefined) {
        throw new ConfirmationNotPendingError(taskId, options.confirms);
      }
      payload = { kind: "confirmation", seq: options.confirms, ...confirmed };
    }
    const turn = task.turn + 1;
    await appendUserVisibleMessage(tx, {
      taskId,
      turn,
      seq: 0,
      role: "customer",
      content,
      ...(payload === undefined ? {} : { payload }),
    });
    await tx
      .update(tasks)
      .set({ state: "READY", turn, updatedAt: sql`now()` })
      .where(eq(tasks.id, taskId));
    return { turn };
  });
}

// The customer ends the session; only between turns, so no executor holds the task.
export async function closeTask(db: ExecutionDb, taskId: string): Promise<Task> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    if (task.state === "CLOSED") {
      return task;
    }
    if (task.state !== "WAITING_USER") {
      throw new TaskNotWaitingForCustomerError(taskId, task.state);
    }
    const [closed] = await tx
      .update(tasks)
      .set({ state: "CLOSED", updatedAt: sql`now()` })
      .where(eq(tasks.id, taskId))
      .returning();
    if (closed === undefined) {
      throw new Error(`Closed task ${taskId} vanished`);
    }
    return closed;
  });
}

// Keyed by (task, turn, seq): writing the same message again is ignored.
export async function appendUserVisibleMessage(
  db: ExecutionQueries,
  message: Omit<UserVisibleMessage, "createdAt" | "payload"> & { payload?: MessagePayload },
): Promise<void> {
  await db.insert(userVisibleMessages).values(message).onConflictDoNothing();
}

export async function listUserVisibleMessages(
  db: ExecutionQueries,
  taskId: string,
): Promise<UserVisibleMessage[]> {
  const rows = await db
    .select()
    .from(userVisibleMessages)
    .where(eq(userVisibleMessages.taskId, taskId))
    .orderBy(asc(userVisibleMessages.turn), asc(userVisibleMessages.seq));
  return rows.map((row) => ({ ...row, payload: row.payload as MessagePayload | null }));
}
