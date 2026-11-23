import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const pgTable = snakeCase.table;

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const taskStates = ["READY", "RUNNING", "WAITING_USER", "CLOSED"] as const;
export const leaseEventKinds = ["claimed", "expired", "rebuilt", "resumed"] as const;
export const stepKinds = ["model", "tool"] as const;
export const stepStatuses = ["ok", "error"] as const;
export const messageRoles = ["customer", "agent"] as const;
export const confirmationStatuses = ["REQUESTED", "CONFIRMED", "INVALIDATED"] as const;
export const writeIntentStates = [
  "PREPARED",
  "SENT",
  "CONFIRMED",
  "UNKNOWN",
  "VERIFIED_DONE",
  "VERIFIED_ABSENT",
  "REJECTED",
  "HANDOFF",
  "CANCELLED",
] as const;

// One run of a scenario under one experiment configuration; its tasks link to it.
export const runs = pgTable("runs", {
  id: uuid().primaryKey().defaultRandom(),
  scenario: text().notNull(),
  // A RunConfig, read by the executors serving the run's tasks.
  config: jsonb().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    customerId: text().notNull(),
    // Null for a task outside any experiment run.
    runId: uuid().references(() => runs.id),
    state: text({ enum: taskStates }).notNull(),
    // Number of the latest turn; 0 until the first customer message.
    turn: integer().notNull().default(0),
    owner: text(),
    // Always computed by PostgreSQL now(), never by the executor's clock (ADR 0002).
    leaseUntil: timestamptz(),
    // Bumped by every claim; checkpoints of an older holder no longer match.
    version: integer().notNull().default(0),
    // Set when a holder's lease ran out; the next holder recovers before going on.
    needsRecovery: boolean().notNull().default(false),
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

// Each executor process start. A container restarted after its process died comes back as a new
// owner on the same host.
export const executorStarts = pgTable("executor_starts", {
  owner: text().primaryKey(),
  host: text().notNull(),
  startedAt: timestamptz().notNull().defaultNow(),
});

// A planned fault point that fired. The primary key lets each fire at most once per run.
export const faultFirings = pgTable(
  "fault_firings",
  {
    runId: uuid()
      .notNull()
      .references(() => runs.id),
    // Its label in the run's fault plan, e.g. after_write_confirmed:create_aftersales.
    faultPoint: text().notNull(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    // The executor instance that dropped itself there.
    owner: text().notNull(),
    // By the database clock, committed before the executor dies: where recovery time starts.
    firedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.faultPoint] })],
);

// What happened to each lease, stamped by the database clock (ADR 0002) so recovery times can
// be computed in SQL. At most one event of a kind per lease version.
export const leaseEvents = pgTable(
  "lease_events",
  {
    // Order of recording.
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    // The lease the event is about: the one that ran out for expired, the new one otherwise.
    version: integer().notNull(),
    kind: text({ enum: leaseEventKinds }).notNull(),
    owner: text().notNull(),
    at: timestamptz().notNull().defaultNow(),
  },
  (t) => [unique("lease_events_once_per_lease").on(t.taskId, t.version, t.kind)],
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
    // Structured part a client acts on, e.g. a question's options or the parameters to confirm.
    payload: jsonb(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.turn, t.seq] })],
);

// What the agent asked the customer to confirm. Only the latest request of a task can be valid:
// a new one invalidates the earlier ones.
export const confirmations = pgTable(
  "confirmations",
  {
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    // The seq of the step that requested it, also the seq of the message that shows it.
    seq: integer().notNull(),
    tool: text().notNull(),
    // Normalized parameters of the write tool.
    parameters: jsonb().notNull(),
    parametersHash: text().notNull(),
    status: text({ enum: confirmationStatuses }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.seq] })],
);

// One per write operation, keyed by its operation ID.
export const writeIntents = pgTable(
  "write_intents",
  {
    operationId: text().primaryKey(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    tool: text().notNull(),
    operation: text().notNull(),
    state: text({ enum: writeIntentStates }).notNull(),
    // The operation's own normalized parameters, as sent.
    parameters: jsonb().notNull(),
    // Business (logical) time, not the database clock: set on entering SENT, carried by the request.
    deadline: timestamptz(),
    // What the business service returned when the write took effect.
    result: jsonb(),
    // The business rejection, once REJECTED.
    error: jsonb(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index("write_intents_by_task").on(t.taskId, t.createdAt)],
);
