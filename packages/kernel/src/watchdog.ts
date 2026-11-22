import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { ExecutionDb } from "./db/database.ts";
import { tasks } from "./db/schema.ts";
import { recordLeaseEvent } from "./lease-events.ts";

export interface WatchdogOptions {
  db: ExecutionDb;
  // Pause between the end of one sweep and the start of the next.
  scanIntervalMs?: number;
  // A failed sweep is reported here and simply tried again on the next one.
  onError?: (error: unknown) => void;
}

export interface Watchdog {
  start(): void;
  // Stops sweeping and waits for a sweep in progress to finish.
  stop(): Promise<void>;
}

// Runs apart from the executors, so a lease still runs out when every holder is gone.
export function createWatchdog(options: WatchdogOptions): Watchdog {
  const scanIntervalMs = options.scanIntervalMs ?? 1000;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let sweeping = Promise.resolve();
  const sweep = () => {
    sweeping = (async () => {
      try {
        await expireLeases(options.db);
      } catch (error) {
        onError(error);
      }
      if (running) {
        timer = setTimeout(sweep, scanIntervalMs);
      }
    })();
  };
  return {
    start() {
      if (!running) {
        running = true;
        timer = setTimeout(sweep, scanIntervalMs);
      }
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await sweeping;
    },
  };
}

export interface ExpiredLease {
  taskId: string;
  // The holder whose lease ran out, and the version it held.
  owner: string;
  version: number;
}

// One watchdog sweep: every RUNNING task whose lease has run out by the database clock goes
// back to READY for a peer to claim, which then recovers it. The version stays, so the next
// claim moves past the expired one.
export async function expireLeases(db: ExecutionDb): Promise<ExpiredLease[]> {
  return db.transaction(async (tx) => {
    // A row a checkpoint or heartbeat holds right now is left to the next sweep.
    const rows = await tx
      .select({ taskId: tasks.id, owner: tasks.owner, version: tasks.version })
      .from(tasks)
      .where(and(eq(tasks.state, "RUNNING"), lte(tasks.leaseUntil, sql`now()`)))
      .for("update", { skipLocked: true });
    if (rows.length === 0) {
      return [];
    }
    const expired = rows.map(({ taskId, owner, version }): ExpiredLease => {
      if (owner === null) {
        throw new Error(`RUNNING task ${taskId} has no owner`);
      }
      return { taskId, owner, version };
    });
    await tx
      .update(tasks)
      .set({
        state: "READY",
        owner: null,
        leaseUntil: null,
        needsRecovery: true,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          tasks.id,
          expired.map((lease) => lease.taskId),
        ),
      );
    for (const lease of expired) {
      await recordLeaseEvent(tx, { ...lease, kind: "expired" });
    }
    return expired;
  });
}
