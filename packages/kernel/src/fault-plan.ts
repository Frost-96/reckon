import { asc, eq } from "drizzle-orm";
import type { ExecutionDb, ExecutionQueries } from "./db/database.ts";
import { faultFirings, runs, tasks } from "./db/schema.ts";
import {
  type FaultPoint,
  type FaultPointHook,
  faultPointLabel,
  reachesPlannedFault,
} from "./fault-points.ts";
import { runConfigSchema } from "./runs.ts";

export interface FaultFiring {
  runId: string;
  faultPoint: string;
  taskId: string;
  owner: string;
  // By the database clock.
  firedAt: Date;
}

export interface FaultPlanOptions {
  db: ExecutionDb;
  // The executor instance the hook belongs to, recorded as the one that fired.
  owner: string;
  // Drops the executor. The executor process kills itself here, without any cleanup.
  fire: (point: FaultPoint) => void | Promise<void>;
}

// A fault point hook that follows the fault plan of each task's run. A planned point fires the
// first time the run reaches it; its firing is committed before `fire`, so a peer reaching the
// same point later in the run goes on.
export function faultPlanOfRun(options: FaultPlanOptions): FaultPointHook {
  const { db, owner } = options;
  return async (point) => {
    const [run] = await db
      .select({ id: runs.id, config: runs.config })
      .from(tasks)
      .innerJoin(runs, eq(runs.id, tasks.runId))
      .where(eq(tasks.id, point.taskId));
    if (run === undefined) {
      return;
    }
    for (const fault of runConfigSchema.parse(run.config).faultPlan) {
      if (!reachesPlannedFault(point, fault)) {
        continue;
      }
      const recorded = await db
        .insert(faultFirings)
        .values({ runId: run.id, faultPoint: faultPointLabel(fault), taskId: point.taskId, owner })
        .onConflictDoNothing()
        .returning({ runId: faultFirings.runId });
      if (recorded.length > 0) {
        await options.fire(point);
        return;
      }
    }
  };
}

export async function listFaultFirings(
  db: ExecutionQueries,
  runId: string,
): Promise<FaultFiring[]> {
  return db
    .select()
    .from(faultFirings)
    .where(eq(faultFirings.runId, runId))
    .orderBy(asc(faultFirings.firedAt));
}
