import {
  type ExecutionDb,
  getTask,
  getUserVisibleMessage,
  listenForTaskNotifications,
  type TaskNotification,
  type TaskNotificationListener,
} from "@reckon/kernel";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { ApiError, messageView, taskIdOf, taskNotFound } from "./tasks.ts";

// One server-sent event: its name and its JSON data.
export interface TaskEvent {
  event: string;
  data: unknown;
}

export interface TaskEventSubscriber {
  onEvent(event: TaskEvent): void;
  // No more events will come, e.g. the hub lost its connection; the client should follow anew.
  onEnd(): void;
}

export interface TaskEventHub {
  // Resolves once the hub listens for the executors' notifications; rejects (and reports) if it
  // cannot.
  ready(): Promise<void>;
  // Events committed after this call reach the subscriber, in commit order, until it unsubscribes.
  subscribe(taskId: string, subscriber: TaskEventSubscriber): () => void;
  close(): Promise<void>;
}

// What a client is sent for a notification. Drafts go out as they are; a written message is
// read back, so the client gets it exactly as GET /tasks/:taskId/messages shows it.
async function present(
  db: ExecutionDb,
  notification: TaskNotification,
): Promise<TaskEvent | undefined> {
  switch (notification.kind) {
    case "draft": {
      const { turn, step, attempt, index, text } = notification;
      return { event: "draft", data: { turn, step, attempt, index, text } };
    }
    case "message": {
      const message = await getUserVisibleMessage(db, notification);
      return message === undefined ? undefined : { event: "message", data: messageView(message) };
    }
  }
}

// Fans the notifications of one dedicated listening connection out to the clients following each
// task. The connection is opened by the first follower, not at startup.
export function createTaskEventHub(
  pool: pg.Pool,
  db: ExecutionDb,
  onError: (error: unknown) => void,
): TaskEventHub {
  const subscribers = new Map<string, Set<TaskEventSubscriber>>();
  let listener: TaskNotificationListener | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  // One at a time, so a message read back does not overtake the drafts committed after it.
  let delivery = Promise.resolve();

  async function deliver(notification: TaskNotification): Promise<void> {
    if (!subscribers.has(notification.taskId)) {
      return;
    }
    const event = await present(db, notification);
    if (event === undefined) {
      return;
    }
    for (const subscriber of subscribers.get(notification.taskId) ?? []) {
      subscriber.onEvent(event);
    }
  }

  function endAll(): void {
    const ending = [...subscribers.values()].flatMap((set) => [...set]);
    subscribers.clear();
    for (const subscriber of ending) {
      subscriber.onEnd();
    }
  }

  async function connect(): Promise<void> {
    const started = await listenForTaskNotifications(pool, {
      onNotification(notification) {
        delivery = delivery.then(() => deliver(notification)).catch(onError);
      },
      onError,
      onLost(error) {
        onError(error);
        listener = undefined;
        endAll();
      },
    });
    if (closed) {
      await started.stop();
      throw new Error("Task event hub closed");
    }
    listener = started;
  }

  return {
    ready() {
      if (closed) {
        return Promise.reject(new Error("Task event hub closed"));
      }
      if (listener !== undefined) {
        return Promise.resolve();
      }
      connecting ??= connect()
        .catch((error: unknown) => {
          onError(error);
          throw error;
        })
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    },
    subscribe(taskId, subscriber) {
      if (listener === undefined) {
        subscriber.onEnd();
        return () => {};
      }
      const set = subscribers.get(taskId) ?? new Set();
      set.add(subscriber);
      subscribers.set(taskId, set);
      return () => {
        set.delete(subscriber);
        if (set.size === 0 && subscribers.get(taskId) === set) {
          subscribers.delete(taskId);
        }
      };
    },
    async close() {
      closed = true;
      endAll();
      await connecting?.catch(() => {});
      await listener?.stop();
      listener = undefined;
    },
  };
}

// GET /tasks/:taskId/events: a server-sent event stream of what happens to the task from now on.
// `draft`: a text fragment of a model call in progress {turn, step, attempt, index, text}.
// `message`: a message written to the conversation, as GET /tasks/:taskId/messages shows it.
export function registerTaskEventRoutes(
  app: FastifyInstance,
  db: ExecutionDb,
  hub: TaskEventHub,
): void {
  app.get("/tasks/:taskId/events", async (request, reply) => {
    const taskId = taskIdOf(request.params);
    if ((await getTask(db, taskId)) === undefined) {
      taskNotFound();
    }
    try {
      await hub.ready();
    } catch {
      throw new ApiError(503, "TASK_EVENTS_UNAVAILABLE", "Task events cannot be followed now");
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    raw.flushHeaders();
    // Subscribed only now, so no event can be written ahead of the headers.
    const unsubscribe = hub.subscribe(taskId, {
      onEvent({ event, data }) {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      onEnd() {
        raw.end();
      },
    });
    raw.on("close", unsubscribe);
  });
}
