import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { ExecutionDb, ExecutionTx } from "./db/database.ts";
import { tasks } from "./db/schema.ts";

export interface Lease {
  taskId: string;
  customerId: string;
  runId: string | null;
  turn: number;
  owner: string;
  version: number;
}

export class LeaseLostError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Lease on task ${taskId} is no longer held`);
    this.name = "LeaseLostError";
    this.taskId = taskId;
  }
}

function leaseUntilFromNow(leaseSeconds: number) {
  return sql`now() + make_interval(secs => ${leaseSeconds})`;
}

export async function claimTask(
  db: ExecutionDb,
  owner: string,
  leaseSeconds: number,
): Promise<Lease | undefined> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.state, "READY"))
      .orderBy(asc(tasks.updatedAt), asc(tasks.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (candidate === undefined) {
      return undefined;
    }
    const [claimed] = await tx
      .update(tasks)
      .set({
        state: "RUNNING",
        owner,
        leaseUntil: leaseUntilFromNow(leaseSeconds),
        version: sql`${tasks.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, candidate.id))
      .returning();
    if (claimed === undefined) {
      throw new Error(`Claimed task ${candidate.id} vanished`);
    }
    return {
      taskId: claimed.id,
      customerId: claimed.customerId,
      runId: claimed.runId,
      turn: claimed.turn,
      owner,
      version: claimed.version,
    };
  });
}

// Held means: still the owner at the claimed version, and not expired by the database clock.
function isHeld(lease: Lease) {
  return and(
    eq(tasks.id, lease.taskId),
    eq(tasks.owner, lease.owner),
    eq(tasks.version, lease.version),
    eq(tasks.state, "RUNNING"),
    gt(tasks.leaseUntil, sql`now()`),
  );
}

// False once the lease is no longer held; it is then never renewed again.
export async function renewLease(
  db: ExecutionDb,
  lease: Lease,
  leaseSeconds: number,
): Promise<boolean> {
  const renewed = await db
    .update(tasks)
    .set({ leaseUntil: leaseUntilFromNow(leaseSeconds) })
    .where(isHeld(lease))
    .returning({ id: tasks.id });
  return renewed.length > 0;
}

// Runs `write` in one transaction with the version check; a lease no longer held rejects it all.
export async function checkpoint<T>(
  db: ExecutionDb,
  lease: Lease,
  write: (tx: ExecutionTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [held] = await tx.select({ id: tasks.id }).from(tasks).where(isHeld(lease)).for("update");
    if (held === undefined) {
      throw new LeaseLostError(lease.taskId);
    }
    return write(tx);
  });
}

// Hands the task back to the customer and gives up the lease (inside a checkpoint).
export async function releaseToCustomer(tx: ExecutionTx, lease: Lease): Promise<void> {
  await tx
    .update(tasks)
    .set({ state: "WAITING_USER", owner: null, leaseUntil: null, updatedAt: sql`now()` })
    .where(eq(tasks.id, lease.taskId));
}
