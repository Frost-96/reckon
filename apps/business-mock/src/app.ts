import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { registerAdminRoutes } from "./admin.ts";
import { findAftersales } from "./aftersales.ts";
import { connectBusinessDb } from "./db/database.ts";
import { Rejection } from "./errors.ts";
import { findAftersalesRules, findOrders } from "./orders.ts";
import { registerWriteRoutes } from "./writes.ts";

export interface AppOptions {
  pool: pg.Pool;
  // The admin interface exists only in the experiment environment.
  adminEnabled?: boolean;
  // Business "now", used for the aftersales window; the logical clock plugs in here.
  now?: () => Date;
}

function orderNotFound(): never {
  throw new Rejection(404, "ORDER_NOT_FOUND", "No such order for this customer");
}

export function buildApp({
  pool,
  adminEnabled = false,
  now = () => new Date(),
}: AppOptions): FastifyInstance {
  const app = Fastify();
  const db = connectBusinessDb(pool);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Rejection) {
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

  app.get<{ Params: { customerId: string } }>("/customers/:customerId/orders", async (request) =>
    findOrders(db, request.params.customerId),
  );

  app.get<{ Params: { customerId: string; orderId: string } }>(
    "/customers/:customerId/orders/:orderId",
    async (request) => {
      const [order] = await findOrders(db, request.params.customerId, request.params.orderId);
      return order ?? orderNotFound();
    },
  );

  app.get<{ Params: { customerId: string; orderId: string } }>(
    "/customers/:customerId/orders/:orderId/aftersales-rules",
    async (request) => {
      const { customerId, orderId } = request.params;
      return (await findAftersalesRules(db, customerId, orderId, now())) ?? orderNotFound();
    },
  );

  app.get<{ Params: { customerId: string }; Querystring: { orderId?: string } }>(
    "/customers/:customerId/aftersales",
    async (request) => {
      const { orderId } = request.query;
      return findAftersales(db, {
        customerId: request.params.customerId,
        ...(orderId === undefined ? {} : { orderId }),
      });
    },
  );

  registerWriteRoutes(app, db, now);

  if (adminEnabled) {
    registerAdminRoutes(app, db);
  }

  return app;
}
