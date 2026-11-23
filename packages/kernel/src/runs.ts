import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ExecutionDb, ExecutionQueries } from "./db/database.ts";
import { runs } from "./db/schema.ts";
import type { ModelForTask } from "./executor.ts";
import { plannedFaultSchema } from "./fault-points.ts";
import { createTurnScriptedModel } from "./scripted-model.ts";

const scriptedToolCall = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const scriptedResponse = z
  .object({
    content: z.string().optional(),
    toolCalls: z.array(scriptedToolCall).optional(),
  })
  .strict();

// What the executors serving a run's tasks need to know about the run.
export const runConfigSchema = z
  .object({
    // The scripted fake model: per turn, the responses to that turn's model calls in order.
    model: z
      .object({ kind: z.literal("scripted"), turns: z.array(z.array(scriptedResponse)) })
      .strict(),
    // Where the executor serving the run drops itself, each point at most once in the run.
    faultPlan: z.array(plannedFaultSchema).default([]),
  })
  .strict();

export type RunConfig = z.output<typeof runConfigSchema>;
// What a run is created from; defaults are filled in.
export type RunConfigInput = z.input<typeof runConfigSchema>;

export interface Run {
  id: string;
  scenario: string;
  config: RunConfig;
  createdAt: Date;
}

export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Run ${runId} not found`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export async function createRun(
  db: ExecutionDb,
  input: { scenario: string; config: RunConfigInput },
): Promise<Run> {
  const config = runConfigSchema.parse(input.config);
  const [run] = await db.insert(runs).values({ scenario: input.scenario, config }).returning();
  if (run === undefined) {
    throw new Error("Run insert returned no row");
  }
  return { ...run, config };
}

export async function getRun(db: ExecutionQueries, runId: string): Promise<Run | undefined> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  return run === undefined ? undefined : { ...run, config: runConfigSchema.parse(run.config) };
}

// The model each task's run brings. A task outside any run has none, so it cannot be served.
export function modelOfRun(db: ExecutionDb): ModelForTask {
  return async ({ taskId, runId }) => {
    const run = runId === null ? undefined : await getRun(db, runId);
    if (run === undefined) {
      throw new Error(`Task ${taskId} belongs to no run, so it has no model`);
    }
    return createTurnScriptedModel(run.config.model.turns);
  };
}
