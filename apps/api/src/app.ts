import { connectExecutionDb } from "@reckon/kernel";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { ApiError, registerTaskRoutes } from "./tasks.ts";

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();

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

  registerTaskRoutes(app, connectExecutionDb(pool));

  return app;
}
