import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  generateDataset,
  loadScenario,
  parseScenario,
  runScenario,
  type ScenarioEnvironment,
} from "./index.ts";
import { type StackUnderTest, startStackUnderTest } from "./test-support.ts";

let stack: StackUnderTest;
let environment: ScenarioEnvironment;

beforeAll(async () => {
  stack = await startStackUnderTest();
  environment = stack.environment;
});

afterAll(async () => {
  await stack.close();
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

test("a simulated user choosing among the offered options does not guess when more than one fits", async () => {
  const [candidates] = generateDataset().dev.filter(
    ({ template }) => template === "candidate-orders",
  );
  const scenario = parseScenario(candidates?.scenario);
  // The product the customer bought in every candidate order, so every option mentions it.
  const productName = scenario.business.orders[0]?.lines[0]?.productName ?? "";
  const ambiguous = {
    ...scenario.simulatedUser,
    answers: { ...scenario.simulatedUser.answers, orderId: { choose: productName } },
  };

  const result = await runScenario({ ...scenario, simulatedUser: ambiguous }, environment);

  expect(result.conversation).toMatchObject({ ended: "question_unanswered", taskState: "CLOSED" });
  expect(result.assertions.flatMap((assertion) => assertion.found)).toEqual([]);
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
