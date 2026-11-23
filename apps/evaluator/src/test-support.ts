import type { AddressInfo } from "node:net";
import { createAftersalesPackage } from "@reckon/aftersales";
import { buildApp } from "@reckon/api";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import {
  type BusinessPackage,
  createExecutor,
  type ExecutionDb,
  type Executor,
  faultPlanOfRun,
  modelOfRun,
  recordExecutorStart,
} from "@reckon/kernel";
import { startExecutionTestDatabase } from "@reckon/kernel/testing";
import { requireEnv } from "@reckon/shared";
import { grantReadAccess } from "@reckon/shared/testing";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { connectBusinessReader } from "./business-assertions.ts";
import type { ScenarioEnvironment } from "./run-scenario.ts";
import type { Scenario } from "./scenario.ts";

const wantedReturn = z
  .object({ orderId: z.string(), lineId: z.string(), quantity: z.int(), reason: z.string() })
  .loose();

// What the customer wants returned: the parameters they would confirm.
export function wantedReturnOf(scenario: Scenario) {
  const wanted = wantedReturn.parse(scenario.simulatedUser.confirmations[0]?.parameters);
  const line = scenario.business.orders
    .find((order) => order.id === wanted.orderId)
    ?.lines.find((orderLine) => orderLine.id === wanted.lineId);
  if (line === undefined) {
    throw new Error(`${scenario.name}: the customer wants a line that is not on file`);
  }
  return { ...wanted, productName: line.productName };
}

// Whether the scenario expects the customer's return to be written, read off its assertions.
export function expectsWantedReturnWritten(scenario: Scenario): boolean {
  const wanted = wantedReturnOf(scenario);
  const onWantedLine = (record: { orderId: string; lineId: string }) =>
    record.orderId === wanted.orderId && record.lineId === wanted.lineId;
  const seeded = scenario.business.aftersales.filter(onWantedLine).length;
  const expected = scenario.expected.business.find(
    (assertion) => onWantedLine(assertion) && assertion.includeSeeded,
  );
  if (expected === undefined) {
    throw new Error(`${scenario.name} asserts nothing about the line the customer wants returned`);
  }
  return expected.count > seeded;
}

export interface StackUnderTest {
  environment: ScenarioEnvironment;
  mock: BusinessMockUnderTest;
  close(): Promise<void>;
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

class Dropped extends Error {}

// An executor instance that follows the fault plan of each run. Where the executor process would
// kill itself, this instance stops claiming and abandons its turn, leaving its lease to run out;
// then a new instance starts on the same host, as the container's restart policy would have it.
async function startExecutor(
  executors: Executor[],
  db: ExecutionDb,
  host: string,
  businessPackage: BusinessPackage,
  generation = 1,
): Promise<void> {
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
        void startExecutor(executors, db, host, businessPackage, generation + 1);
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

// The services of the experiment stack, run in-process on their own databases, over real HTTP:
// two executor instances, the task API with its watchdog, the business mock, and the evaluator's
// read-only business role.
export async function startStackUnderTest(): Promise<StackUnderTest> {
  const mock = await startBusinessMock();
  const businessMockUrl = await listen(mock.app);
  const database = await startExecutionTestDatabase();
  const api = buildApp(database.pool, { watchdogScanIntervalMs: 50 });
  const businessPackage = createAftersalesPackage({ businessServiceUrl: businessMockUrl });
  const executors: Executor[] = [];
  await startExecutor(executors, database.db, "host-1", businessPackage);
  await startExecutor(executors, database.db, "host-2", businessPackage);
  const business = connectBusinessReader(
    await grantReadAccess(mock.databaseUrl, requireEnv("BUSINESS_READER_DATABASE_URL")),
  );
  return {
    environment: {
      taskApiUrl: await listen(api),
      businessMockUrl,
      executionDb: database.db,
      business,
      pollIntervalMs: 20,
      turnTimeoutMs: 10_000,
    },
    mock,
    async close() {
      await Promise.all(executors.map((executor) => executor.stop()));
      await business.close();
      await api.close();
      await database.close();
      await mock.close();
    },
  };
}
