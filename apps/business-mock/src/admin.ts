import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { defaultMockConfig, type MockConfig, readMockConfig, writeMockConfig } from "./config.ts";
import type { BusinessDb } from "./db/database.ts";
import {
  aftersalesOrders,
  aftersalesPolicy,
  aftersalesStatuses,
  idempotencyKeys,
  idempotencyModes,
  mockConfig,
  orderLines,
  orderStatuses,
  orders,
  returnShipments,
} from "./db/schema.ts";
import { parseRequest, timestamp } from "./errors.ts";

// The business initial data of a scenario, sent by the evaluator (which never writes the database).
const fixtureSchema = z.object({
  policy: z.object({
    returnWindowDays: z.int().nonnegative(),
    returnFeeCents: z.int().nonnegative(),
  }),
  orders: z.array(
    z.object({
      id: z.string().min(1),
      customerId: z.string().min(1),
      status: z.enum(orderStatuses),
      deliveredAt: timestamp,
      lines: z
        .array(
          z.object({
            id: z.string().min(1),
            productName: z.string().min(1),
            quantity: z.int().positive(),
          }),
        )
        .min(1),
    }),
  ),
  // Applications already on file, typically someone else's (no client ref, no deadline).
  aftersales: z
    .array(
      z.object({
        id: z.string().min(1),
        orderId: z.string().min(1),
        lineId: z.string().min(1),
        quantity: z.int().positive(),
        reason: z.string().min(1),
        status: z.enum(aftersalesStatuses),
        returnFeeCents: z.int().nonnegative().default(0),
        clientRef: z.string().min(1).nullable().default(null),
      }),
    )
    .default([]),
});

const resetSchema = z.object({ seed: z.string().min(1), fixture: fixtureSchema });

const configPatchSchema = z
  .object({
    idempotencyMode: z.enum(idempotencyModes),
    checkFee: z.boolean(),
    processingDelayMs: z.int().nonnegative(),
  })
  .partial()
  .strict();

export function registerAdminRoutes(app: FastifyInstance, db: BusinessDb): void {
  // Replaces all business data with the scenario's and restores the default switches.
  app.post("/admin/reset", async (request, reply) => {
    const { seed, fixture } = parseRequest(resetSchema, request.body);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`truncate ${returnShipments}, ${aftersalesOrders}, ${orderLines}, ${orders}, ${aftersalesPolicy}, ${idempotencyKeys}, ${mockConfig}`,
      );
      await tx.insert(aftersalesPolicy).values({ id: 1, ...fixture.policy });
      if (fixture.orders.length > 0) {
        await tx.insert(orders).values(
          fixture.orders.map((order) => ({
            id: order.id,
            customerId: order.customerId,
            status: order.status,
            deliveredAt: new Date(order.deliveredAt),
          })),
        );
        await tx
          .insert(orderLines)
          .values(
            fixture.orders.flatMap((order) =>
              order.lines.map((line) => ({ orderId: order.id, ...line })),
            ),
          );
      }
      if (fixture.aftersales.length > 0) {
        await tx.insert(aftersalesOrders).values(fixture.aftersales);
      }
      await writeMockConfig(tx, { ...defaultMockConfig, scenarioSeed: seed });
    });
    return reply.code(204).send();
  });

  app.get("/admin/config", async () => readMockConfig(db));

  app.patch("/admin/config", async (request) => {
    const patch = parseRequest(configPatchSchema, request.body);
    return db.transaction(async (tx) => {
      const current = await readMockConfig(tx);
      const config: MockConfig = {
        scenarioSeed: current.scenarioSeed,
        idempotencyMode: patch.idempotencyMode ?? current.idempotencyMode,
        checkFee: patch.checkFee ?? current.checkFee,
        processingDelayMs: patch.processingDelayMs ?? current.processingDelayMs,
      };
      await writeMockConfig(tx, config);
      return config;
    });
  });
}
