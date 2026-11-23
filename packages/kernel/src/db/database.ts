import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

export type ExecutionDb = NodePgDatabase;
export type ExecutionTx = Parameters<Parameters<ExecutionDb["transaction"]>[0]>[0];
// Either the pool-backed database or an open transaction.
export type ExecutionQueries = ExecutionDb | ExecutionTx;

export function connectExecutionDb(pool: pg.Pool): ExecutionDb {
  return drizzle({ client: pool });
}

// Applies the committed migrations; the same folder `drizzle-kit migrate` applies.
export async function migrateExecutionDatabase(pool: pg.Pool): Promise<void> {
  await migrate(connectExecutionDb(pool), {
    migrationsFolder: join(import.meta.dirname, "migrations"),
  });
}
