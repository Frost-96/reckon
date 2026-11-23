import { createRun, type ExecutionDb } from "@reckon/kernel";
import {
  type AssertionResult,
  type BusinessReader,
  checkBusinessAssertions,
} from "./business-assertions.ts";
import { resetBusinessMock, taskApi } from "./http.ts";
import { businessFixture, type OutcomeCategory, type Scenario } from "./scenario.ts";
import { type Conversation, converse } from "./simulated-user.ts";

export interface ScenarioEnvironment {
  taskApiUrl: string;
  // Its admin API must be enabled.
  businessMockUrl: string;
  // Where the run is recorded; the simulated user itself only uses the task API.
  executionDb: ExecutionDb;
  business: BusinessReader;
  // The run's start, from which the scenario's relative times are fixed.
  now?: () => Date;
  pollIntervalMs?: number;
  turnTimeoutMs?: number;
}

export interface ScenarioResult {
  scenario: string;
  runId: string;
  // The expected end category was reached and every business assertion holds.
  passed: boolean;
  outcome: { expected: OutcomeCategory; actual: OutcomeCategory | null; achieved: boolean };
  conversation: Conversation;
  assertions: AssertionResult[];
}

export async function runScenario(
  scenario: Scenario,
  environment: ScenarioEnvironment,
): Promise<ScenarioResult> {
  const now = environment.now ?? (() => new Date());
  await resetBusinessMock(environment.businessMockUrl, {
    seed: scenario.seed,
    fixture: businessFixture(scenario.business, now()),
  });
  const run = await createRun(environment.executionDb, {
    scenario: scenario.name,
    config: { model: { kind: "scripted", turns: scenario.model.turns } },
  });
  const conversation = await converse(taskApi(environment.taskApiUrl), scenario.simulatedUser, {
    runId: run.id,
    pollIntervalMs: environment.pollIntervalMs ?? 100,
    turnTimeoutMs: environment.turnTimeoutMs ?? 60_000,
  });
  const assertions = await checkBusinessAssertions(
    environment.business.db,
    scenario.expected.business,
    new Set(scenario.business.aftersales.map((record) => record.id)),
  );
  const actual = outcomeOf(conversation);
  const achieved = actual === scenario.expected.outcome;
  return {
    scenario: scenario.name,
    runId: run.id,
    passed: achieved && assertions.every((result) => result.passed),
    outcome: { expected: scenario.expected.outcome, actual, achieved },
    conversation,
    assertions,
  };
}

// Only "auto_completed" can be told apart so far: reconfirmed, stopped and handed_off need the
// dispositions and handoffs the kernel does not record yet.
function outcomeOf(conversation: Conversation): OutcomeCategory | null {
  return conversation.ended === "script_completed" ? "auto_completed" : null;
}
