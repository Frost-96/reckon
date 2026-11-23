import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAftersalesPackage } from "@reckon/aftersales";
import { buildApp } from "@reckon/api";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import {
  createExecutor,
  type Executor,
  faultPlanOfRun,
  modelOfRun,
  recordExecutorStart,
} from "@reckon/kernel";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "@reckon/kernel/testing";
import { requireEnv } from "@reckon/shared";
import { grantReadAccess } from "@reckon/shared/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type BusinessReader,
  connectBusinessReader,
  loadScenario,
  runScenario,
  type ScenarioEnvironment,
} from "./index.ts";

// The services of the experiment stack, run in-process on their own databases.
let mock: BusinessMockUnderTest;
let database: ExecutionTestDatabase;
let api: FastifyInstance;
const executors: Executor[] = [];
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
  api = buildApp(database.pool, { watchdogScanIntervalMs: 50 });
  const businessPackage = createAftersalesPackage({ businessServiceUrl: businessMockUrl });
  await startExecutor("host-1", businessPackage);
  await startExecutor("host-2", businessPackage);
  business = connectBusinessReader(
    await grantReadAccess(mock.databaseUrl, requireEnv("BUSINESS_READER_DATABASE_URL")),
  );
  environment = {
    taskApiUrl: await listen(api),
    businessMockUrl,
    executionDb: database.db,
    business,
    pollIntervalMs: 20,
    turnTimeoutMs: 10_000,
  };
});

class Dropped extends Error {}

// An executor instance that follows the fault plan of each run. Where the executor process would
// kill itself, this instance stops claiming and abandons its turn, leaving its lease to run out;
// then a new instance starts on the same host, as the container's restart policy would have it.
async function startExecutor(
  host: string,
  businessPackage: ReturnType<typeof createAftersalesPackage>,
  generation = 1,
): Promise<void> {
  const db = database.db;
  const owner = `${host}-executor-${generation}`;
  await recordExecutorStart(db, { owner, host });
  const executor: Executor = createExecutor({
    db,
    owner,
    businessPackage,
    model: modelOfRun(db),
    pollIntervalMs: 20,
    leaseSeconds: 0.5,
    heartbeatIntervalMs: 100,
    onFaultPoint: faultPlanOfRun({
      db,
      owner,
      fire() {
        void executor.stop();
        void startExecutor(host, businessPackage, generation + 1);
        throw new Dropped(`${owner} dropped itself`);
      },
    }),
    onError(error) {
      if (!(error instanceof Dropped)) {
        console.error(error);
      }
    },
  });
  executor.start();
  executors.push(executor);
}

afterAll(async () => {
  await Promise.all(executors.map((executor) => executor.stop()));
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

test("the executor drops itself between the two writes and a peer finishes the return, written exactly once", async () => {
  const scenario = await loadScenario(returnOneKettle);

  const result = await runScenario(scenario, environment, {
    faultPlan: [{ point: "after_write_confirmed", target: "create_aftersales" }],
  });

  expect(result).toMatchObject({
    passed: true,
    outcome: { expected: "auto_completed", actual: "auto_completed", achieved: true },
    conversation: { ended: "script_completed", taskState: "CLOSED" },
  });
  expect(result.assertions).toMatchObject([
    { passed: true, found: [{ quantity: 1, returnShipment: true }] },
    { passed: true, found: [] },
  ]);
  const recovery = {
    detectionMs: expect.any(Number),
    claimMs: expect.any(Number),
    rebuildMs: expect.any(Number),
    resumeMs: expect.any(Number),
  };
  expect(result.faults).toEqual([
    {
      faultPoint: "after_write_confirmed:create_aftersales",
      fired: true,
      recovery,
      // Reported on its own: a peer, not the restarted instance, carries the recovery.
      containerRestartMs: expect.any(Number),
    },
  ]);
  for (const segment of Object.values(result.faults[0]?.recovery ?? {})) {
    expect(segment).toBeGreaterThanOrEqual(0);
  }
});

test("a run whose planned fault point was never reached does not pass, though the return went through", async () => {
  const scenario = await loadScenario(returnOneKettle);

  const result = await runScenario(scenario, environment, {
    faultPlan: [{ point: "after_write_confirmed", target: "no_such_operation" }],
  });

  expect(result).toMatchObject({
    passed: false,
    outcome: { actual: "auto_completed", achieved: true },
    faults: [
      {
        faultPoint: "after_write_confirmed:no_such_operation",
        fired: false,
        recovery: null,
        containerRestartMs: null,
      },
    ],
  });
  expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
});

const orderStatusStreamed = join(import.meta.dirname, "../scenarios/order-status-streamed.json");

test("the customer following the stream sees each draft give way to the written message, also drafts of calls that went on to tools", async () => {
  const scenario = await loadScenario(returnOneKettle);

  const result = await runScenario(scenario, environment, { watchStream: true });

  expect(result.passed).toBe(true);
  expect(result.stream).toEqual({
    consistent: true,
    drafts: [
      { turn: 1, step: 1, attempt: 1, text: "我先查一下这笔订单。", fate: "replaced" },
      {
        turn: 3,
        step: 9,
        attempt: 3,
        text: "已为您提交退货申请，并生成了寄回单。",
        fate: "replaced",
      },
      {
        turn: 4,
        step: 12,
        attempt: 4,
        text: "您的退货申请正在处理中，电水壶还可再退 1 件。",
        fate: "replaced",
      },
    ],
  });
});

test("the executor drops itself while the reply streams in: the customer's draft is discarded for the peer's new attempt and the reply shows once", async () => {
  const scenario = await loadScenario(orderStatusStreamed);
  const reply =
    "您的订单 O1 已于两天前签收，包含电水壶 2 件和马克杯 1 件；如需退货，签收后 7 天内都可以申请。";

  const result = await runScenario(scenario, environment, {
    faultPlan: [{ point: "mid_model_stream" }],
    watchStream: true,
  });

  expect(result).toMatchObject({
    passed: true,
    outcome: { actual: "auto_completed", achieved: true },
    conversation: { ended: "script_completed", taskState: "CLOSED" },
    faults: [{ faultPoint: "mid_model_stream", fired: true }],
  });
  expect(result.stream).toEqual({
    consistent: true,
    drafts: [
      { turn: 1, step: 3, attempt: 1, text: "您的订单", fate: "discarded" },
      { turn: 1, step: 3, attempt: 2, text: reply, fate: "replaced" },
    ],
  });
  expect(result.conversation.messages).toMatchObject([
    { role: "customer", content: "我的订单 O1 现在是什么状态？" },
    { role: "agent", seq: 3, content: reply },
  ]);
});
