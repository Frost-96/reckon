import type { AddressInfo } from "node:net";
import { createExecutor, createScriptedModel } from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildApp } from "./app.ts";

let database: ExecutionTestDatabase;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  app = buildApp(database.pool);
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

async function startTask(): Promise<string> {
  return (await call<{ id: string }>("POST", "/tasks", { customerId: "C1" })).id;
}

interface ServerSentEvent {
  event: string;
  data: unknown;
}

// Reads the task's event stream as a browser's EventSource would, keeping every event.
async function follow(taskId: string) {
  const controller = new AbortController();
  const response = await fetch(new URL(`/tasks/${taskId}/events`, baseUrl), {
    signal: controller.signal,
  });
  const events: ServerSentEvent[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body ?? []) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const fields = new Map(
          buffer
            .slice(0, end)
            .split("\n")
            .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
        );
        buffer = buffer.slice(end + 2);
        events.push({
          event: fields.get("event") ?? "",
          data: JSON.parse(fields.get("data") ?? ""),
        });
      }
    }
  })().catch(() => {});
  return {
    response,
    events,
    async close() {
      controller.abort();
      await reading;
    },
  };
}

test("a customer following a task sees the agent's reply stream in as drafts, then the written message, and nothing of other tasks", async () => {
  const taskId = await startTask();
  const otherTaskId = await startTask();
  const stream = await follow(taskId);
  expect(stream.response.status).toBe(200);
  expect(stream.response.headers.get("content-type")).toBe("text/event-stream");

  await call("POST", `/tasks/${otherTaskId}/messages`, { content: "在吗" });
  await call("POST", `/tasks/${taskId}/messages`, { content: "你好" });
  const executor = createExecutor({
    db: database.db,
    owner: "executor-1",
    businessPackage: { systemPrompt: "", tools: [] },
    model: createScriptedModel([{ content: "在的。" }, { content: "您好，请问是哪一笔订单？" }]),
  });
  while (await executor.runOnce()) {}

  const messages = await call<unknown[]>("GET", `/tasks/${taskId}/messages`);
  const draft = { turn: 1, step: 1, attempt: 1 };
  await vi.waitFor(() =>
    expect(stream.events).toEqual([
      { event: "message", data: messages[0] },
      { event: "draft", data: { ...draft, index: 0, text: "您好，请" } },
      { event: "draft", data: { ...draft, index: 1, text: "问是哪一" } },
      { event: "draft", data: { ...draft, index: 2, text: "笔订单？" } },
      { event: "message", data: messages[1] },
    ]),
  );
  expect(messages).toMatchObject([
    { role: "customer", content: "你好" },
    { role: "agent", content: "您好，请问是哪一笔订单？" },
  ]);
  await stream.close();
});

test("following a task that does not exist is refused", async () => {
  const response = await fetch(new URL(`/tasks/${crypto.randomUUID()}/events`, baseUrl));

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
});
