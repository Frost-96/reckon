import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();

  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return app;
}
