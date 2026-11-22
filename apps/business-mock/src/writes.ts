import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { findAftersales, toReturnShipmentView } from "./aftersales.ts";
import type { MockConfig } from "./config.ts";
import type { BusinessDb, BusinessTx } from "./db/database.ts";
import { aftersalesOrders, orders, returnShipments } from "./db/schema.ts";
import { businessRejection, parseRequest, timestamp } from "./errors.ts";
import { runIdempotentWrite, type WriteOutcome } from "./idempotency.ts";
import { deriveDocumentId } from "./ids.ts";
import { findOrders, readPolicy, returnDeadline } from "./orders.ts";

const createAftersalesSchema = z
  .object({
    customerId: z.string().min(1),
    orderId: z.string().min(1),
    lineId: z.string().min(1),
    quantity: z.int().positive(),
    reason: z.string().min(1),
    // The fee the customer confirmed (ADR 0006).
    returnFeeCents: z.int().nonnegative(),
    clientRef: z.string().min(1),
    // Only stored for now; rejecting expired requests comes with #17.
    deadline: timestamp,
  })
  .strict();

const createReturnShipmentSchema = z
  .object({
    customerId: z.string().min(1),
    clientRef: z.string().min(1),
    deadline: timestamp,
  })
  .strict();

type CreateAftersalesInput = z.output<typeof createAftersalesSchema>;
type CreateReturnShipmentInput = z.output<typeof createReturnShipmentSchema>;

// Runs inside the committing transaction; locks the order so concurrent writes to it serialize.
async function checkCreateAftersales(
  tx: BusinessTx,
  input: CreateAftersalesInput,
  config: MockConfig,
  now: Date,
): Promise<void> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update");
  if (order === undefined) {
    throw businessRejection("ORDER_NOT_FOUND", `Order ${input.orderId} does not exist`);
  }
  if (order.customerId !== input.customerId) {
    throw businessRejection("ORDER_NOT_OWNED", `Order ${input.orderId} belongs to someone else`);
  }
  if (order.status === "refunded") {
    throw businessRejection("ORDER_REFUNDED", `Order ${input.orderId} has been refunded`);
  }
  const [view] = await findOrders(tx, input.customerId, input.orderId);
  const line = view?.lines.find((candidate) => candidate.id === input.lineId);
  if (line === undefined) {
    throw businessRejection("LINE_NOT_FOUND", `Order ${input.orderId} has no line ${input.lineId}`);
  }
  const policy = await readPolicy(tx);
  if (now > returnDeadline(order.deliveredAt, policy.returnWindowDays)) {
    throw businessRejection("AFTERSALES_WINDOW_EXPIRED", "The aftersales window has closed");
  }
  const [active] = await tx
    .select({ id: aftersalesOrders.id })
    .from(aftersalesOrders)
    .where(
      and(
        eq(aftersalesOrders.orderId, input.orderId),
        eq(aftersalesOrders.lineId, input.lineId),
        eq(aftersalesOrders.status, "in_progress"),
      ),
    );
  if (active !== undefined) {
    throw businessRejection(
      "ACTIVE_AFTERSALES_EXISTS",
      `Aftersales order ${active.id} for this item is still in progress`,
    );
  }
  if (input.quantity > line.returnableQuantity) {
    throw businessRejection(
      "QUANTITY_EXCEEDS_RETURNABLE",
      `Only ${line.returnableQuantity} of this item can be returned`,
    );
  }
  if (config.checkFee && input.returnFeeCents !== policy.returnFeeCents) {
    throw businessRejection(
      "FEE_CHANGED",
      `The return fee is now ${policy.returnFeeCents}, not ${input.returnFeeCents}`,
    );
  }
}

export function registerWriteRoutes(app: FastifyInstance, db: BusinessDb, now: () => Date): void {
  app.post("/aftersales", async (request, reply) => {
    const input = parseRequest(createAftersalesSchema, request.body);
    const { deadline: _deadline, ...parameters } = input;
    const outcome = await runIdempotentWrite(
      db,
      { endpoint: "create_aftersales", key: idempotencyKeyOf(request), parameters },
      async (tx, config) => {
        await checkCreateAftersales(tx, input, config, now());
        const id = deriveDocumentId("AS", config.scenarioSeed, input.clientRef);
        await tx.insert(aftersalesOrders).values({
          id,
          orderId: input.orderId,
          lineId: input.lineId,
          quantity: input.quantity,
          reason: input.reason,
          status: "in_progress",
          returnFeeCents: input.returnFeeCents,
          clientRef: input.clientRef,
          deadline: new Date(input.deadline),
        });
        const [view] = await findAftersales(tx, {
          customerId: input.customerId,
          aftersalesId: id,
        });
        if (view === undefined) {
          throw new Error(`Aftersales order ${id} vanished inside its own transaction`);
        }
        return { statusCode: 201, body: view };
      },
    );
    return sendOutcome(reply, outcome);
  });

  // The fee is settled when the aftersales order is created (ADR 0006), so it is not rechecked.
  app.post<{ Params: { aftersalesId: string } }>(
    "/aftersales/:aftersalesId/return-shipments",
    async (request, reply) => {
      const { aftersalesId } = request.params;
      const input = parseRequest(createReturnShipmentSchema, request.body);
      const { deadline: _deadline, ...body } = input;
      const outcome = await runIdempotentWrite(
        db,
        {
          endpoint: "create_return_shipment",
          key: idempotencyKeyOf(request),
          parameters: { aftersalesId, ...body },
        },
        async (tx, config) => {
          await checkCreateReturnShipment(tx, aftersalesId, input);
          const [shipment] = await tx
            .insert(returnShipments)
            .values({
              id: deriveDocumentId("RS", config.scenarioSeed, input.clientRef),
              aftersalesId,
              clientRef: input.clientRef,
              deadline: new Date(input.deadline),
            })
            .returning();
          if (shipment === undefined) {
            throw new Error("Inserting the return shipment returned no row");
          }
          return { statusCode: 201, body: toReturnShipmentView(shipment) };
        },
      );
      return sendOutcome(reply, outcome);
    },
  );
}

function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return Array.isArray(header) ? header[0] : header;
}

function sendOutcome(reply: FastifyReply, outcome: WriteOutcome): FastifyReply {
  if (outcome.replayed) {
    reply.header("idempotent-replayed", "true");
  }
  return reply.code(outcome.statusCode).send(outcome.body);
}

async function checkCreateReturnShipment(
  tx: BusinessTx,
  aftersalesId: string,
  input: CreateReturnShipmentInput,
): Promise<void> {
  const [aftersales] = await tx
    .select({ id: aftersalesOrders.id })
    .from(aftersalesOrders)
    .innerJoin(orders, eq(orders.id, aftersalesOrders.orderId))
    .where(and(eq(aftersalesOrders.id, aftersalesId), eq(orders.customerId, input.customerId)))
    .for("update", { of: aftersalesOrders });
  if (aftersales === undefined) {
    throw businessRejection(
      "AFTERSALES_NOT_FOUND",
      `No aftersales order ${aftersalesId} for this customer`,
    );
  }
  const [existing] = await tx
    .select({ id: returnShipments.id })
    .from(returnShipments)
    .where(eq(returnShipments.aftersalesId, aftersalesId));
  if (existing !== undefined) {
    throw businessRejection(
      "RETURN_SHIPMENT_EXISTS",
      `Aftersales order ${aftersalesId} already has return shipment ${existing.id}`,
    );
  }
}
