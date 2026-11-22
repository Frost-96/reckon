import { asc, eq } from "drizzle-orm";
import type { ExecutionQueries } from "./db/database.ts";
import { type stepStatuses, steps } from "./db/schema.ts";
import type { ModelResponse } from "./model.ts";

export type StepStatus = (typeof stepStatuses)[number];

interface StepBase {
  taskId: string;
  seq: number;
  turn: number;
  // "error": the output is a structured error that was returned to the model.
  status: StepStatus;
  attempt: number;
  inputHash: string;
}

export interface ToolCallInput {
  toolCallId: string;
  name: string;
  arguments: string;
}

export interface ModelStep extends StepBase {
  kind: "model";
  output: ModelResponse;
}

export interface ToolStep extends StepBase {
  kind: "tool";
  input: ToolCallInput;
  // Exactly what the model was given as the tool result.
  output: unknown;
}

export type NewStep = ModelStep | ToolStep;
export type Step = NewStep & { createdAt: Date };

export async function appendStep(db: ExecutionQueries, step: NewStep): Promise<void> {
  await db.insert(steps).values({ ...step, input: step.kind === "tool" ? step.input : null });
}

export async function readStepLog(db: ExecutionQueries, taskId: string): Promise<Step[]> {
  const rows = await db
    .select()
    .from(steps)
    .where(eq(steps.taskId, taskId))
    .orderBy(asc(steps.seq));
  return rows.map((row): Step => {
    const base = {
      taskId: row.taskId,
      seq: row.seq,
      turn: row.turn,
      status: row.status,
      attempt: row.attempt,
      inputHash: row.inputHash,
      createdAt: row.createdAt,
    };
    return row.kind === "model"
      ? { ...base, kind: "model", output: row.output as ModelResponse }
      : { ...base, kind: "tool", input: row.input as ToolCallInput, output: row.output };
  });
}
