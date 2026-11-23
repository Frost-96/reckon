import { createExecutor, createScriptedModel } from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildApp } from "./app.ts";

let database: ExecutionTestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  app = buildApp(database.pool, { watchdogScanIntervalMs: 50 });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function taskState(taskId: string): Promise<string> {
  return (await app.inject({ method: "GET", url: `/tasks/${taskId}` })).json().state;
}

test("the task API puts a task back to READY once the executor holding it is gone and its lease has run out", async () => {
  const taskId = (
    await app.inject({ method: "POST", url: "/tasks", payload: { customerId: "C1" } })
  ).json().id;
  await app.inject({
    method: "POST",
    url: `/tasks/${taskId}/messages`,
    payload: { content: "hi" },
  });
  const dropped = createExecutor({
    db: database.db,
    owner: "executor-1",
    businessPackage: { systemPrompt: "", tools: [] },
    model: createScriptedModel([
      () => {
        throw new Error("executor dropped");
      },
    ]),
    leaseSeconds: 0.5,
  });
  await expect(dropped.runOnce()).rejects.toThrow("executor dropped");
  expect(await taskState(taskId)).toBe("RUNNING");

  await vi.waitFor(async () => expect(await taskState(taskId)).toBe("READY"), {
    timeout: 3000,
    interval: 50,
  });
});
