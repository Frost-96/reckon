import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const pgTable = snakeCase.table;

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const taskStates = ["READY", "RUNNING", "WAITING_USER"] as const;
export const stepKinds = ["model", "tool"] as const;
export const stepStatuses = ["ok", "error"] as const;
export const messageRoles = ["customer", "agent"] as const;

export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    customerId: text().notNull(),
    state: text({ enum: taskStates }).notNull(),
    // Number of the latest turn; 0 until the first customer message.
    turn: integer().notNull().default(0),
    owner: text(),
    // Always computed by PostgreSQL now(), never by the executor's clock (ADR 0002).
    leaseUntil: timestamptz(),
    // Bumped by every claim; checkpoints of an older holder no longer match.
    version: integer().notNull().default(0),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check(
      "tasks_lease_iff_running",
      sql`(${t.state} = 'RUNNING') = (${t.owner} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`,
    ),
    index("tasks_ready_queue").on(t.updatedAt, t.id).where(sql`${t.state} = 'READY'`),
  ],
);

// Append-only (enforced by a trigger in the migrations).
export const steps = pgTable(
  "steps",
  {
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    // Position in the task's whole log, starting at 1.
    seq: integer().notNull(),
    turn: integer().notNull(),
    kind: text({ enum: stepKinds }).notNull(),
    status: text({ enum: stepStatuses }).notNull(),
    // The lease version the step ran under, so a takeover always gets a new attempt number.
    attempt: integer().notNull(),
    inputHash: text().notNull(),
    // Tool steps: the tool call as the model sent it. Model steps keep only the request hash.
    input: jsonb(),
    output: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.seq] })],
);

export const userVisibleMessages = pgTable(
  "user_visible_messages",
  {
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    turn: integer().notNull(),
    seq: integer().notNull(),
    role: text({ enum: messageRoles }).notNull(),
    content: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.turn, t.seq] })],
);
