import { aftersalesOrders, returnShipments } from "@reckon/business-mock/schema";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { BusinessAssertion } from "./scenario.ts";

export interface BusinessReader {
  db: NodePgDatabase;
  close(): Promise<void>;
}

// Every transaction on these sessions is read-only: the evaluator never writes business data.
export function connectBusinessReader(url: string): BusinessReader {
  const pool = new pg.Pool({
    connectionString: url,
    options: "-c default_transaction_read_only=on",
  });
  return { db: drizzle({ client: pool }), close: () => pool.end() };
}

export interface FoundAftersales {
  id: string;
  quantity: number;
  status: string;
  returnFeeCents: number;
  clientRef: string | null;
  returnShipment: boolean;
}

export interface AssertionResult {
  assertion: BusinessAssertion;
  passed: boolean;
  failures: string[];
  found: FoundAftersales[];
}

const checkedFields = ["quantity", "returnFeeCents", "status", "returnShipment"] as const;

async function checkAftersales(
  db: NodePgDatabase,
  assertion: BusinessAssertion,
): Promise<AssertionResult> {
  const rows = await db
    .select({
      id: aftersalesOrders.id,
      quantity: aftersalesOrders.quantity,
      status: aftersalesOrders.status,
      returnFeeCents: aftersalesOrders.returnFeeCents,
      clientRef: aftersalesOrders.clientRef,
      returnShipmentId: returnShipments.id,
    })
    .from(aftersalesOrders)
    .leftJoin(returnShipments, eq(returnShipments.aftersalesId, aftersalesOrders.id))
    .where(
      and(
        eq(aftersalesOrders.orderId, assertion.orderId),
        eq(aftersalesOrders.lineId, assertion.lineId),
      ),
    )
    .orderBy(asc(aftersalesOrders.createdAt), asc(aftersalesOrders.id));
  const found = rows.map(({ returnShipmentId, ...record }) => ({
    ...record,
    returnShipment: returnShipmentId !== null,
  }));
  const failures: string[] = [];
  if (found.length !== assertion.count) {
    failures.push(`expected ${assertion.count} aftersales orders, found ${found.length}`);
  }
  for (const record of found) {
    for (const field of checkedFields) {
      const expected = assertion[field];
      if (expected !== undefined && record[field] !== expected) {
        failures.push(`${record.id}: ${field} is ${record[field]}, expected ${expected}`);
      }
    }
  }
  return { assertion, passed: failures.length === 0, failures, found };
}

export async function checkBusinessAssertions(
  db: NodePgDatabase,
  assertions: readonly BusinessAssertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await checkAftersales(db, assertion));
  }
  return results;
}
