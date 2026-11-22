import { and, asc, eq, sql } from "drizzle-orm";
import type { ToolError } from "./business-package.ts";
import type { ExecutionQueries } from "./db/database.ts";
import { type writeIntentStates, writeIntents } from "./db/schema.ts";

export type WriteIntentState = (typeof writeIntentStates)[number];

export interface WriteIntent {
  operationId: string;
  taskId: string;
  tool: string;
  operation: string;
  state: WriteIntentState;
  parameters: unknown;
  deadline: Date | null;
  result: unknown;
  error: ToolError | null;
  createdAt: Date;
  updatedAt: Date;
}

// The state machine's transitions implemented so far, each with what it records.
export type WriteIntentTransition =
  // Persisted before the request goes out, with the deadline the request carries.
  | { from: "PREPARED"; to: "SENT"; deadline: Date }
  | { from: "SENT"; to: "CONFIRMED"; result: unknown }
  | { from: "SENT"; to: "REJECTED"; error: ToolError };

export async function prepareWriteIntent(
  db: ExecutionQueries,
  intent: Pick<WriteIntent, "operationId" | "taskId" | "tool" | "operation" | "parameters">,
): Promise<void> {
  await db.insert(writeIntents).values({ ...intent, state: "PREPARED" });
}

export async function transitionWriteIntent(
  db: ExecutionQueries,
  operationId: string,
  transition: WriteIntentTransition,
): Promise<void> {
  const { from, to, ...changes } = transition;
  const moved = await db
    .update(writeIntents)
    .set({ ...changes, state: to, updatedAt: sql`now()` })
    .where(and(eq(writeIntents.operationId, operationId), eq(writeIntents.state, from)))
    .returning({ operationId: writeIntents.operationId });
  if (moved.length === 0) {
    throw new Error(`Write intent ${operationId} is not ${from}; cannot move it to ${to}`);
  }
}

export async function replacePreparedParameters(
  db: ExecutionQueries,
  operationId: string,
  parameters: unknown,
): Promise<void> {
  const replaced = await db
    .update(writeIntents)
    .set({ parameters, updatedAt: sql`now()` })
    .where(and(eq(writeIntents.operationId, operationId), eq(writeIntents.state, "PREPARED")))
    .returning({ operationId: writeIntents.operationId });
  if (replaced.length === 0) {
    throw new Error(`Write intent ${operationId} is no longer PREPARED; its parameters stay`);
  }
}

export async function listWriteIntents(
  db: ExecutionQueries,
  taskId: string,
): Promise<WriteIntent[]> {
  const rows = await db
    .select()
    .from(writeIntents)
    .where(eq(writeIntents.taskId, taskId))
    .orderBy(asc(writeIntents.createdAt), asc(writeIntents.operationId));
  return rows.map((row) => ({ ...row, error: row.error as ToolError | null }));
}
