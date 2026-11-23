import { type ExecutionDb, faultPointLabel, type PlannedFault } from "@reckon/kernel";
import { executorStarts, faultFirings, leaseEvents } from "@reckon/kernel/schema";
import { and, type Column, eq, gt, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// Milliseconds between the kernel's database timestamps; null where the later event never happened.
export interface RecoveryTimings {
  // Fault fired -> the watchdog found the dead holder's lease run out.
  detectionMs: number | null;
  // Expiry detected -> a peer instance claimed the task.
  claimMs: number | null;
  // Claimed -> the peer rebuilt the task's progress from the step log.
  rebuildMs: number | null;
  // Rebuilt -> recovery over, execution resumed.
  resumeMs: number | null;
}

export interface FaultReport {
  // As labelled in the run's fault plan.
  faultPoint: string;
  fired: boolean;
  // Only for a fault that fired.
  recovery: RecoveryTimings | null;
  // Fault fired -> a new executor process started on the dead one's host. Not part of the
  // recovery, which a peer carries out meanwhile; null while none has started.
  containerRestartMs: number | null;
}

const expired = alias(leaseEvents, "expired");
const claimed = alias(leaseEvents, "claimed");
const rebuilt = alias(leaseEvents, "rebuilt");
const resumed = alias(leaseEvents, "resumed");
const dead = alias(executorStarts, "dead");
const restarted = alias(executorStarts, "restarted");

function msBetween(from: Column, to: Column) {
  return sql<number | null>`(extract(epoch from ${to} - ${from}) * 1000)::float8`;
}

// The lease the peer took over is the one after the dead holder's.
function eventOfTakeover(
  event: { taskId: Column; kind: Column; version: Column },
  kind: "claimed" | "rebuilt" | "resumed",
) {
  return and(
    eq(event.taskId, expired.taskId),
    eq(event.kind, kind),
    eq(event.version, sql`${expired.version} + 1`),
  );
}

// Each planned fault point of the run, and for those that fired, the recovery that followed,
// computed from the lease events and process starts the kernel stamps with the database clock.
export async function reportFaults(
  db: ExecutionDb,
  runId: string,
  faultPlan: readonly PlannedFault[],
): Promise<FaultReport[]> {
  const recoveries = await db
    .select({
      faultPoint: faultFirings.faultPoint,
      detectionMs: msBetween(faultFirings.firedAt, expired.at),
      claimMs: msBetween(expired.at, claimed.at),
      rebuildMs: msBetween(claimed.at, rebuilt.at),
      resumeMs: msBetween(rebuilt.at, resumed.at),
    })
    .from(faultFirings)
    .leftJoin(
      expired,
      and(
        eq(expired.taskId, faultFirings.taskId),
        eq(expired.kind, "expired"),
        eq(expired.owner, faultFirings.owner),
        gte(expired.at, faultFirings.firedAt),
      ),
    )
    .leftJoin(claimed, eventOfTakeover(claimed, "claimed"))
    .leftJoin(rebuilt, eventOfTakeover(rebuilt, "rebuilt"))
    .leftJoin(resumed, eventOfTakeover(resumed, "resumed"))
    .where(eq(faultFirings.runId, runId));
  const restarts = await db
    .select({
      faultPoint: faultFirings.faultPoint,
      containerRestartMs: sql<number>`(extract(epoch from min(${restarted.startedAt}) - ${faultFirings.firedAt}) * 1000)::float8`,
    })
    .from(faultFirings)
    .innerJoin(dead, eq(dead.owner, faultFirings.owner))
    .innerJoin(
      restarted,
      and(eq(restarted.host, dead.host), gt(restarted.startedAt, faultFirings.firedAt)),
    )
    .where(eq(faultFirings.runId, runId))
    .groupBy(faultFirings.faultPoint, faultFirings.firedAt);
  return faultPlan.map((fault) => {
    const faultPoint = faultPointLabel(fault);
    const recovery = recoveries.find((fired) => fired.faultPoint === faultPoint);
    if (recovery === undefined) {
      return { faultPoint, fired: false, recovery: null, containerRestartMs: null };
    }
    const { detectionMs, claimMs, rebuildMs, resumeMs } = recovery;
    const restart = restarts.find((fired) => fired.faultPoint === faultPoint);
    return {
      faultPoint,
      fired: true,
      recovery: { detectionMs, claimMs, rebuildMs, resumeMs },
      containerRestartMs: restart?.containerRestartMs ?? null,
    };
  });
}
