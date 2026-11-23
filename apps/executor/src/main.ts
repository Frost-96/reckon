import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createAftersalesPackage } from "@reckon/aftersales";
import {
  connectExecutionDb,
  createExecutor,
  faultPlanOfRun,
  modelOfRun,
  recordExecutorStart,
} from "@reckon/kernel";
import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { createHealthServer } from "./health.ts";

const pool = new pg.Pool({ connectionString: requireEnv("EXECUTION_DATABASE_URL") });
const db = connectExecutionDb(pool);
const server = createHealthServer(pool);
// A restarted container keeps its hostname, so its new process is a new owner on the same host.
const host = hostname();
const owner = `${host}-${randomUUID().slice(0, 8)}`;
await recordExecutorStart(db, { owner, host });

// A planned fault kills this process on the spot, as a real crash would: no cleanup, no lease
// release, no reply. It only takes effect because the process is not PID 1 (compose `init: true`).
function killSelf(): Promise<never> {
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => {});
}

const executor = createExecutor({
  db,
  owner,
  businessPackage: createAftersalesPackage({
    businessServiceUrl: requireEnv("BUSINESS_SERVICE_URL"),
  }),
  // Until a real model is wired in, only tasks of a run that scripts its model can be served.
  model: modelOfRun(db),
  onFaultPoint: faultPlanOfRun({ db, owner, fire: killSelf }),
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
