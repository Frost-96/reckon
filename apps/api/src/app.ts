import { connectExecutionDb, createWatchdog } from "@reckon/kernel";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { createTaskEventHub, registerTaskEventRoutes } from "./task-events.ts";
import { ApiError, registerTaskRoutes } from "./tasks.ts";

export interface AppOptions {
  // How often the lease watchdog sweeps while the app is up.
  watchdogScanIntervalMs?: number;
}

export function buildApp(pool: pg.Pool, options: AppOptions = {}): FastifyInstance {
  const app = Fastify();
  const db = connectExecutionDb(pool);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  });

  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  registerTaskRoutes(app, db);

  const hub = createTaskEventHub(pool, db, (error) => console.error(error));
  registerTaskEventRoutes(app, db, hub);
  // Open event streams would keep the server from closing; they end first.
  app.addHook("preClose", async () => hub.close());

  // The lease watchdog lives in the task API, apart from the executors whose leases it watches.
  const { watchdogScanIntervalMs } = options;
  const watchdog = createWatchdog({
    db,
    ...(watchdogScanIntervalMs === undefined ? {} : { scanIntervalMs: watchdogScanIntervalMs }),
  });
  app.addHook("onReady", async () => watchdog.start());
  app.addHook("onClose", async () => watchdog.stop());

  return app;
}
