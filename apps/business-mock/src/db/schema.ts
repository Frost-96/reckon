import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const pgTable = snakeCase.table;

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const orderStatuses = ["delivered", "refunded"] as const;
export const aftersalesStatuses = ["in_progress", "completed", "closed"] as const;
export const idempotencyModes = ["key"] as const;

// Settings of the mock itself, not business data. Single row; absent until the first reset.
export const mockConfig = pgTable(
  "mock_config",
  {
    id: integer().primaryKey().default(1),
    scenarioSeed: text().notNull(),
    idempotencyMode: text({ enum: idempotencyModes }).notNull(),
    checkFee: boolean().notNull(),
    processingDelayMs: integer().notNull(),
  },
  (t) => [
    check("mock_config_single_row", sql`${t.id} = 1`),
    check("mock_config_processing_delay_non_negative", sql`${t.processingDelayMs} >= 0`),
  ],
);

// Single row: the shop-wide aftersales policy of the current scenario.
export const aftersalesPolicy = pgTable(
  "aftersales_policy",
  {
    id: integer().primaryKey().default(1),
    returnWindowDays: integer().notNull(),
    returnFeeCents: integer().notNull(),
  },
  (t) => [
    check("aftersales_policy_single_row", sql`${t.id} = 1`),
    check("aftersales_policy_window_non_negative", sql`${t.returnWindowDays} >= 0`),
    check("aftersales_policy_fee_non_negative", sql`${t.returnFeeCents} >= 0`),
  ],
);

export const orders = pgTable("orders", {
  id: text().primaryKey(),
  customerId: text().notNull(),
  status: text({ enum: orderStatuses }).notNull(),
  deliveredAt: timestamptz().notNull(),
});

export const orderLines = pgTable(
  "order_lines",
  {
    orderId: text()
      .notNull()
      .references(() => orders.id),
    id: text().notNull(),
    productName: text().notNull(),
    quantity: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.id] }),
    check("order_lines_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

export const aftersalesOrders = pgTable(
  "aftersales_orders",
  {
    id: text().primaryKey(),
    orderId: text().notNull(),
    lineId: text().notNull(),
    quantity: integer().notNull(),
    reason: text().notNull(),
    status: text({ enum: aftersalesStatuses }).notNull(),
    returnFeeCents: integer().notNull(),
    // Operation ID submitted by the writer; null for records seeded as someone else's.
    clientRef: text(),
    // Deadline carried by the write request; null for seeded records.
    deadline: timestamptz(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orderId, t.lineId],
      foreignColumns: [orderLines.orderId, orderLines.id],
    }),
    check("aftersales_orders_quantity_positive", sql`${t.quantity} > 0`),
    uniqueIndex("aftersales_orders_one_in_progress_per_line")
      .on(t.orderId, t.lineId)
      .where(sql`${t.status} = 'in_progress'`),
  ],
);

export const returnShipments = pgTable("return_shipments", {
  id: text().primaryKey(),
  aftersalesId: text()
    .notNull()
    .unique()
    .references(() => aftersalesOrders.id),
  clientRef: text().notNull(),
  deadline: timestamptz().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
});

// Registered only when a write commits; holds the response replayed for the same key.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    endpoint: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    statusCode: integer().notNull(),
    response: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.endpoint, t.key] })],
);
