import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

export type BusinessDb = NodePgDatabase;
export type BusinessTx = Parameters<Parameters<BusinessDb["transaction"]>[0]>[0];
// Either the pool-backed database or an open transaction.
export type BusinessQueries = BusinessDb | BusinessTx;

export function connectBusinessDb(pool: pg.Pool): BusinessDb {
  return drizzle({ client: pool });
}

// Applies the committed migrations; the same folder `drizzle-kit migrate` applies.
export async function migrateBusinessDatabase(pool: pg.Pool): Promise<void> {
  await migrate(connectBusinessDb(pool), {
    migrationsFolder: join(import.meta.dirname, "migrations"),
  });
}
