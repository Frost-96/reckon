import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BusinessQueries } from "./db/database.ts";
import {
  aftersalesOrders,
  aftersalesPolicy,
  orderLines,
  type orderStatuses,
  orders,
} from "./db/schema.ts";

// Aftersales orders in these statuses use up the line's returnable quantity.
const claimingStatuses = ["in_progress", "completed"] as const;

export interface OrderLineView {
  id: string;
  productName: string;
  quantity: number;
  returnableQuantity: number;
}

export interface OrderView {
  id: string;
  customerId: string;
  status: (typeof orderStatuses)[number];
  deliveredAt: string;
  lines: OrderLineView[];
}

export interface AftersalesRulesView {
  orderId: string;
  returnWindowDays: number;
  returnDeadline: string;
  withinReturnWindow: boolean;
  returnFeeCents: number;
}

export async function readPolicy(db: BusinessQueries) {
  const [policy] = await db.select().from(aftersalesPolicy);
  if (policy === undefined) {
    throw new Error("No aftersales policy: reset the mock to a scenario first");
  }
  return policy;
}

export function returnDeadline(deliveredAt: Date, returnWindowDays: number): Date {
  return new Date(deliveredAt.getTime() + returnWindowDays * 24 * 60 * 60 * 1000);
}

export async function findAftersalesRules(
  db: BusinessQueries,
  customerId: string,
  orderId: string,
  now: Date,
): Promise<AftersalesRulesView | undefined> {
  const [order] = await db
    .select({ deliveredAt: orders.deliveredAt })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.id, orderId)));
  if (order === undefined) {
    return undefined;
  }
  const policy = await readPolicy(db);
  const deadline = returnDeadline(order.deliveredAt, policy.returnWindowDays);
  return {
    orderId,
    returnWindowDays: policy.returnWindowDays,
    returnDeadline: deadline.toISOString(),
    withinReturnWindow: now <= deadline,
    returnFeeCents: policy.returnFeeCents,
  };
}

export async function findOrders(
  db: BusinessQueries,
  customerId: string,
  orderId?: string,
): Promise<OrderView[]> {
  const orderRows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        orderId === undefined ? undefined : eq(orders.id, orderId),
      ),
    )
    .orderBy(asc(orders.deliveredAt), asc(orders.id));
  if (orderRows.length === 0) {
    return [];
  }
  const lineRows = await db
    .select({
      orderId: orderLines.orderId,
      id: orderLines.id,
      productName: orderLines.productName,
      quantity: orderLines.quantity,
      claimed: sql<number>`coalesce(sum(${aftersalesOrders.quantity}), 0)::int`,
    })
    .from(orderLines)
    .leftJoin(
      aftersalesOrders,
      and(
        eq(aftersalesOrders.orderId, orderLines.orderId),
        eq(aftersalesOrders.lineId, orderLines.id),
        inArray(aftersalesOrders.status, [...claimingStatuses]),
      ),
    )
    .where(
      inArray(
        orderLines.orderId,
        orderRows.map((order) => order.id),
      ),
    )
    .groupBy(orderLines.orderId, orderLines.id)
    .orderBy(asc(orderLines.orderId), asc(orderLines.id));

  return orderRows.map((order) => ({
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    deliveredAt: order.deliveredAt.toISOString(),
    lines: lineRows
      .filter((line) => line.orderId === order.id)
      .map(({ claimed, orderId: _orderId, ...line }) => ({
        ...line,
        returnableQuantity: order.status === "refunded" ? 0 : Math.max(line.quantity - claimed, 0),
      })),
  }));
}
