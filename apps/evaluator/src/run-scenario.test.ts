import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAftersalesPackage } from "@reckon/aftersales";
import { buildApp } from "@reckon/api";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import { createExecutor, type Executor, modelOfRun } from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type BusinessReader,
  connectBusinessReader,
  loadScenario,
  runScenario,
  type ScenarioEnvironment,
} from "./index.ts";

// The services of the compose stack, run in-process on their own databases.
let mock: BusinessMockUnderTest;
let database: ExecutionTestDatabase;
let api: FastifyInstance;
let executor: Executor;
let business: BusinessReader;
let environment: ScenarioEnvironment;

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  mock = await startBusinessMock();
  const businessMockUrl = await listen(mock.app);
  database = await startExecutionTestDatabase();
  api = buildApp(database.pool);
  executor = createExecutor({
    db: database.db,
    owner: "executor-1",
    businessPackage: createAftersalesPackage({ businessServiceUrl: businessMockUrl }),
    model: modelOfRun(database.db),
    pollIntervalMs: 20,
  });
  executor.start();
  business = connectBusinessReader(mock.databaseUrl);
  environment = {
    taskApiUrl: await listen(api),
    businessMockUrl,
    executionDb: database.db,
    business,
    pollIntervalMs: 20,
    turnTimeoutMs: 10_000,
  };
});

afterAll(async () => {
  await executor.stop();
  await business.close();
  await api.close();
  await database.close();
  await mock.close();
});

const returnOneKettle = join(import.meta.dirname, "../scenarios/return-one-kettle.json");

test("the simulated user gets one kettle returned and the business database confirms it", async () => {
  const scenario = await loadScenario(returnOneKettle);

  const result = await runScenario(scenario, environment);

  expect(result).toMatchObject({
    scenario: "return-one-kettle",
    passed: true,
    outcome: { expected: "auto_completed", actual: "auto_completed", achieved: true },
    conversation: { ended: "script_completed", taskState: "CLOSED" },
  });
  expect(result.assertions).toMatchObject([
    {
      passed: true,
      found: [{ quantity: 1, returnFeeCents: 800, status: "in_progress", returnShipment: true }],
    },
    { passed: true, found: [] },
  ]);
});

test("the simulated user refuses to confirm parameters it does not expect, so nothing is written and the run fails", async () => {
  const scenario = await loadScenario(returnOneKettle);
  const expectsTwo = {
    tool: "submit_return",
    parameters: {
      orderId: "O1",
      lineId: "L1",
      quantity: 2,
      reason: "不想要了",
      returnFeeCents: 800,
    },
  };

  const result = await runScenario(
    { ...scenario, simulatedUser: { ...scenario.simulatedUser, confirmations: [expectsTwo] } },
    environment,
  );

  expect(result).toMatchObject({
    passed: false,
    outcome: { expected: "auto_completed", actual: null, achieved: false },
    conversation: { ended: "confirmation_refused", taskState: "CLOSED" },
  });
  expect(result.assertions).toMatchObject([
    { passed: false, found: [] },
    { passed: true, found: [] },
  ]);
});
