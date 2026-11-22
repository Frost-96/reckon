import { asc, eq } from "drizzle-orm";
import type { ExecutionQueries } from "./db/database.ts";
import { type leaseEventKinds, leaseEvents } from "./db/schema.ts";

// claimed: a holder took the lease. expired: the watchdog found it run out. rebuilt: the next
// holder has its progress back from the step log. resumed: recovery is over and the turn goes on.
export type LeaseEventKind = (typeof leaseEventKinds)[number];

export interface LeaseEvent {
  taskId: string;
  version: number;
  kind: LeaseEventKind;
  owner: string;
  // By the database clock.
  at: Date;
}

export async function recordLeaseEvent(
  db: ExecutionQueries,
  event: Omit<LeaseEvent, "at">,
): Promise<void> {
  await db.insert(leaseEvents).values(event);
}

// In the order they were recorded.
export async function listLeaseEvents(db: ExecutionQueries, taskId: string): Promise<LeaseEvent[]> {
  return db
    .select({
      taskId: leaseEvents.taskId,
      version: leaseEvents.version,
      kind: leaseEvents.kind,
      owner: leaseEvents.owner,
      at: leaseEvents.at,
    })
    .from(leaseEvents)
    .where(eq(leaseEvents.taskId, taskId))
    .orderBy(asc(leaseEvents.id));
}
