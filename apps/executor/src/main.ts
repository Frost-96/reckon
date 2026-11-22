import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createAftersalesPackage } from "@reckon/aftersales";
import { connectExecutionDb, createExecutor, modelOfRun } from "@reckon/kernel";
import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { createHealthServer } from "./health.ts";

const pool = new pg.Pool({ connectionString: requireEnv("EXECUTION_DATABASE_URL") });
const db = connectExecutionDb(pool);
const server = createHealthServer(pool);
// Unique per process, also when a container restarts with the same hostname.
const owner = `${hostname()}-${randomUUID().slice(0, 8)}`;
const executor = createExecutor({
  db,
  owner,
  businessPackage: createAftersalesPackage({
    businessServiceUrl: requireEnv("BUSINESS_SERVICE_URL"),
  }),
  // Until a real model is wired in, only tasks of a run that scripts its model can be served.
  model: modelOfRun(db),
});

server.listen(Number(requireEnv("PORT")), "0.0.0.0");
executor.start();
console.log(`Executor ${owner} started`);

async function shutdown(): Promise<void> {
  await executor.stop();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
