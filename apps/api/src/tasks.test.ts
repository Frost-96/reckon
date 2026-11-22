import { randomUUID } from "node:crypto";
import { createExecutor, createScriptedModel } from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "./app.ts";

let database: ExecutionTestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  app = buildApp(database.pool);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function startTask(customerId = "C1"): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/tasks", payload: { customerId } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

function sendMessage(taskId: string, content: string) {
  return app.inject({ method: "POST", url: `/tasks/${taskId}/messages`, payload: { content } });
}

test("a customer starts a task and their message queues it for an executor", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: { customerId: "C1" },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ customerId: "C1", state: "WAITING_USER" });
  const taskId = created.json().id;

  const sent = await sendMessage(taskId, "我想退货");

  expect(sent.statusCode).toBe(202);
  expect(sent.json()).toEqual({ turn: 1 });
  const task = await app.inject({ method: "GET", url: `/tasks/${taskId}` });
  expect(task.json()).toEqual({ id: taskId, customerId: "C1", state: "READY", turn: 1 });
});

test("the customer reads the agent's reply once an executor has run the turn", async () => {
  const taskId = await startTask();
  await sendMessage(taskId, "你好");

  const executor = createExecutor({
    db: database.db,
    owner: "executor-1",
    businessPackage: { systemPrompt: "", tools: [] },
    model: createScriptedModel(Array(10).fill({ content: "您好，请问需要什么帮助？" })),
  });
  // Other tests leave READY tasks behind; serve them all.
  while (await executor.runOnce()) {}

  const messages = await app.inject({ method: "GET", url: `/tasks/${taskId}/messages` });
  expect(messages.statusCode).toBe(200);
  expect(messages.json()).toMatchObject([
    { turn: 1, seq: 0, role: "customer", content: "你好" },
    { turn: 1, seq: 1, role: "agent", content: "您好，请问需要什么帮助？" },
  ]);
  const task = await app.inject({ method: "GET", url: `/tasks/${taskId}` });
  expect(task.json()).toMatchObject({ state: "WAITING_USER" });
});

test("a message is refused while the task is not waiting for the customer", async () => {
  const taskId = await startTask();
  await sendMessage(taskId, "first");

  const second = await sendMessage(taskId, "second");

  expect(second.statusCode).toBe(409);
  expect(second.json()).toMatchObject({ error: { code: "TASK_NOT_WAITING_FOR_CUSTOMER" } });
});

test.each([randomUUID(), "not-a-task-id"])("task %s is not found", async (taskId) => {
  for (const response of [
    await app.inject({ method: "GET", url: `/tasks/${taskId}` }),
    await app.inject({ method: "GET", url: `/tasks/${taskId}/messages` }),
    await sendMessage(taskId, "hello"),
  ]) {
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  }
});

test.each([
  ["a task without a customer", "/tasks", {}],
  ["an empty message", "/tasks/00000000-0000-4000-8000-000000000000/messages", { content: "" }],
])("%s is an invalid request", async (_case, url, payload) => {
  const response = await app.inject({ method: "POST", url, payload });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
});
