import { randomBytes } from "node:crypto";
import pg from "pg";
import { requireEnv } from "./env.ts";

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

// Creates a fresh database owned by the role in `roleUrl`, so each test file gets its own.
// Needs POSTGRES_ADMIN_URL (a superuser) because the application roles cannot create databases.
export async function createTestDatabase(roleUrl: string): Promise<TestDatabase> {
  const url = new URL(roleUrl);
  const owner = decodeURIComponent(url.username);
  const name = `${url.pathname.slice(1)}_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: requireEnv("POSTGRES_ADMIN_URL") });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${pg.escapeIdentifier(name)} OWNER ${pg.escapeIdentifier(owner)}`,
    );
    await admin.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(name)} FROM PUBLIC`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: requireEnv("POSTGRES_ADMIN_URL") });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
