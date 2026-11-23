import type { AddressInfo } from "node:net";
import { createAftersalesPackage } from "@reckon/aftersales";
import { buildApp } from "@reckon/api";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import { createExecutor, modelOfRun } from "@reckon/kernel";
import { startExecutionTestDatabase } from "@reckon/kernel/testing";
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

// The services of the compose stack, run in-process on their own databases, over real HTTP.
export async function startStackUnderTest(): Promise<StackUnderTest> {
  const mock = await startBusinessMock();
  const businessMockUrl = await listen(mock.app);
  const database = await startExecutionTestDatabase();
  const api = buildApp(database.pool);
  const executor = createExecutor({
    db: database.db,
    owner: "executor-1",
    businessPackage: createAftersalesPackage({ businessServiceUrl: businessMockUrl }),
    model: modelOfRun(database.db),
    pollIntervalMs: 5,
  });
  executor.start();
  const business = connectBusinessReader(mock.databaseUrl);
  return {
    environment: {
      taskApiUrl: await listen(api),
      businessMockUrl,
      executionDb: database.db,
      business,
      pollIntervalMs: 5,
      turnTimeoutMs: 10_000,
    },
    mock,
    async close() {
      await executor.stop();
      await business.close();
      await api.close();
      await database.close();
      await mock.close();
    },
  };
}
