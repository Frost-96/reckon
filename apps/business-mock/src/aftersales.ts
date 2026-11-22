import { and, asc, eq } from "drizzle-orm";
import type { BusinessQueries } from "./db/database.ts";
import { aftersalesOrders, type aftersalesStatuses, orders, returnShipments } from "./db/schema.ts";

export interface ReturnShipmentView {
  id: string;
  aftersalesId: string;
  clientRef: string;
  deadline: string;
}

export interface AftersalesView {
  id: string;
  orderId: string;
  lineId: string;
  quantity: number;
  reason: string;
  status: (typeof aftersalesStatuses)[number];
  returnFeeCents: number;
  clientRef: string | null;
  deadline: string | null;
  returnShipment: ReturnShipmentView | null;
}

// Wall-clock creation times are deliberately left out: they differ between runs of a scenario.
export async function findAftersales(
  db: BusinessQueries,
  filter: { customerId: string; orderId?: string; aftersalesId?: string },
): Promise<AftersalesView[]> {
  const rows = await db
    .select({ aftersales: aftersalesOrders, shipment: returnShipments })
    .from(aftersalesOrders)
    .innerJoin(orders, eq(orders.id, aftersalesOrders.orderId))
    .leftJoin(returnShipments, eq(returnShipments.aftersalesId, aftersalesOrders.id))
    .where(
      and(
        eq(orders.customerId, filter.customerId),
        filter.orderId === undefined ? undefined : eq(aftersalesOrders.orderId, filter.orderId),
        filter.aftersalesId === undefined
          ? undefined
          : eq(aftersalesOrders.id, filter.aftersalesId),
      ),
    )
    .orderBy(asc(aftersalesOrders.createdAt), asc(aftersalesOrders.id));

  return rows.map(({ aftersales, shipment }) => ({
    id: aftersales.id,
    orderId: aftersales.orderId,
    lineId: aftersales.lineId,
    quantity: aftersales.quantity,
    reason: aftersales.reason,
    status: aftersales.status,
    returnFeeCents: aftersales.returnFeeCents,
    clientRef: aftersales.clientRef,
    deadline: aftersales.deadline?.toISOString() ?? null,
    returnShipment: shipment === null ? null : toReturnShipmentView(shipment),
  }));
}

export function toReturnShipmentView(
  shipment: typeof returnShipments.$inferSelect,
): ReturnShipmentView {
  return {
    id: shipment.id,
    aftersalesId: shipment.aftersalesId,
    clientRef: shipment.clientRef,
    deadline: shipment.deadline.toISOString(),
  };
}
