import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { buildApp } from "./app.ts";
import { migrateBusinessDatabase } from "./db/database.ts";

const pool = new pg.Pool({ connectionString: requireEnv("BUSINESS_DATABASE_URL") });
await migrateBusinessDatabase(pool);
const app = buildApp({ pool, adminEnabled: process.env.ADMIN_API_ENABLED === "true" });

await app.listen({ host: "0.0.0.0", port: Number(requireEnv("PORT")) });

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
