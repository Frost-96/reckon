import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { createHealthServer } from "./health.ts";

const pool = new pg.Pool({ connectionString: requireEnv("EXECUTION_DATABASE_URL") });
const server = createHealthServer(pool);

server.listen(Number(requireEnv("PORT")), "0.0.0.0");

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
