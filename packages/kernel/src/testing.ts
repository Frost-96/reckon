import { requireEnv } from "@reckon/shared";
import { createTestDatabase } from "@reckon/shared/testing";
import pg from "pg";
import { connectExecutionDb, type ExecutionDb, migrateExecutionDatabase } from "./db/database.ts";
import { expireLeases } from "./watchdog.ts";

export interface ExecutionTestDatabase {
  db: ExecutionDb;
  pool: pg.Pool;
  close(): Promise<void>;
}

// A freshly migrated execution database of its own, connected as the `execution` role.
export async function startExecutionTestDatabase(): Promise<ExecutionTestDatabase> {
  const database = await createTestDatabase(requireEnv("EXECUTION_DATABASE_URL"));
  const pool = new pg.Pool({ connectionString: database.url });
  await migrateExecutionDatabase(pool);
  return {
    db: connectExecutionDb(pool),
    pool,
    async close() {
      await pool.end();
      await database.drop();
    },
  };
}

// Sweeps as the watchdog does until it has found the task's lease run out (by the database
// clock) and put the task back to READY.
export async function sweepUntilExpired(
  db: ExecutionDb,
  taskId: string,
  timeoutMs = 5000,
): Promise<void> {
  const giveUpAt = Date.now() + timeoutMs;
  while (!(await expireLeases(db)).some((lease) => lease.taskId === taskId)) {
    if (Date.now() > giveUpAt) {
      throw new Error(`The lease on task ${taskId} did not run out within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
