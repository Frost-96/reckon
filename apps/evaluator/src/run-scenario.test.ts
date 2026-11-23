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
