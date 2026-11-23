import { sql } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import type { ExecutionQueries } from "./db/database.ts";

// The PostgreSQL channel the task API listens on to push what happens to a task to its clients.
const channel = "task_events";

const position = z.int().nonnegative();

// A kind added here is pushed by the task API once it knows how to present it.
const taskNotificationSchema = z.discriminatedUnion("kind", [
  // A text fragment of a model call still in progress, so only a draft: the call's step, and any
  // message it produces, are written once the call is complete. `step` is the seq the call's
  // step will take and `attempt` the lease version it runs under; a takeover calls the model
  // again under a new attempt. `index` counts the fragments of this call under this attempt.
  z
    .object({
      kind: z.literal("draft"),
      taskId: z.string(),
      turn: position,
      step: position,
      attempt: position,
      index: position,
      text: z.string(),
    })
    .strict(),
  // A user-visible message was written. Sent with the transaction that wrote it, so it arrives
  // only once the message is there to read; it names the message instead of carrying it, which
  // keeps it within PostgreSQL's notification size limit.
  z
    .object({ kind: z.literal("message"), taskId: z.string(), turn: position, seq: position })
    .strict(),
]);

export type TaskNotification = z.output<typeof taskNotificationSchema>;
export type DraftNotification = Extract<TaskNotification, { kind: "draft" }>;

// Inside a transaction it is delivered on commit, and never if the transaction rolls back.
export async function notifyTask(
  db: ExecutionQueries,
  notification: TaskNotification,
): Promise<void> {
  await db.execute(sql`select pg_notify(${channel}, ${JSON.stringify(notification)})`);
}

export interface TaskNotificationHandlers {
  // In commit order of the transactions that sent them.
  onNotification(notification: TaskNotification): void;
  // A notification that is not one of the known kinds; listening goes on.
  onError(error: unknown): void;
  // The connection is gone, and with it every notification until a new listener is started.
  onLost(error: unknown): void;
}

export interface TaskNotificationListener {
  stop(): Promise<void>;
}

// Listens on a connection of its own, taken from the pool for as long as the listener lives.
export async function listenForTaskNotifications(
  pool: pg.Pool,
  handlers: TaskNotificationHandlers,
): Promise<TaskNotificationListener> {
  const client = await pool.connect();
  let ended = false;
  const onNotification = (message: pg.Notification) => {
    if (message.channel !== channel) {
      return;
    }
    let notification: TaskNotification;
    try {
      notification = taskNotificationSchema.parse(JSON.parse(message.payload ?? ""));
    } catch (error) {
      handlers.onError(error);
      return;
    }
    handlers.onNotification(notification);
  };
  // Destroys the connection rather than return a listening one to the pool. The error handler
  // stays: a late error on the closing connection must not go unhandled.
  const end = (error?: Error) => {
    ended = true;
    client.off("notification", onNotification);
    client.release(error ?? true);
  };
  const onLost = (error: Error) => {
    if (!ended) {
      end(error);
      handlers.onLost(error);
    }
  };
  client.on("notification", onNotification);
  client.on("error", onLost);
  try {
    await client.query(`LISTEN ${channel}`);
  } catch (error) {
    end(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return {
    async stop() {
      if (!ended) {
        end();
      }
    },
  };
}
