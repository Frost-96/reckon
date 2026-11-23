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

async function asAdmin(database: string, run: (admin: pg.Client) => Promise<void>): Promise<void> {
  const url = new URL(requireEnv("POSTGRES_ADMIN_URL"));
  url.pathname = `/${database}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

// Lets the role in `readerUrl` select from every table the owner of the database at
// `databaseUrl` creates in its public schema, and nothing else, as the compose init script does
// for the evaluator on the business database. Creates the role if the cluster lacks it (e.g. a
// volume initialized before the role existed). Returns the reader's URL for that database.
export async function grantReadAccess(databaseUrl: string, readerUrl: string): Promise<string> {
  const database = new URL(databaseUrl);
  const name = database.pathname.slice(1);
  const owner = pg.escapeIdentifier(decodeURIComponent(database.username));
  const reader = new URL(readerUrl);
  const roleName = decodeURIComponent(reader.username);
  const role = pg.escapeIdentifier(roleName);
  await asAdmin("postgres", async (admin) => {
    await admin.query("BEGIN");
    // Test files run in parallel: one creates the role while the others wait.
    await admin.query("SELECT pg_advisory_xact_lock(hashtext('reckon:test-roles'))");
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    if (existing.rowCount === 0) {
      const password = pg.escapeLiteral(decodeURIComponent(reader.password));
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${password}`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(name)} TO ${role}`);
    await admin.query("COMMIT");
  });
  await asAdmin(name, async (admin) => {
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`,
    );
  });
  reader.pathname = `/${name}`;
  return reader.toString();
}
