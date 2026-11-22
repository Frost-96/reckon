import { requireEnv } from "@reckon/shared";
import { createTestDatabase } from "@reckon/shared/testing";
import pg from "pg";
import { connectExecutionDb, type ExecutionDb, migrateExecutionDatabase } from "./db/database.ts";

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
