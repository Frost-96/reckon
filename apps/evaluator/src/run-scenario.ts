import { setTimeout as sleep } from "node:timers/promises";
import { createRun, type ExecutionDb, type PlannedFault } from "@reckon/kernel";
import { canonicalJson } from "@reckon/shared";
import {
  type AssertionResult,
  type BusinessReader,
  checkBusinessAssertions,
} from "./business-assertions.ts";
import { type DraftRecord, viewOf } from "./customer-view.ts";
import { type MessageView, resetBusinessMock, taskApi } from "./http.ts";
import { type FaultReport, reportFaults } from "./recovery-timings.ts";
import { businessFixture, type OutcomeCategory, type Scenario } from "./scenario.ts";
import { type Conversation, converse } from "./simulated-user.ts";
import { followTask, type TaskStream } from "./task-stream.ts";

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

// How this run of the scenario is disturbed.
export interface RunOptions {
  // Where the executor serving the run drops itself, each point at most once.
  faultPlan?: PlannedFault[];
  // Follow the task's event stream as the customer's client would, and judge what it showed.
  watchStream?: boolean;
}

// What the customer following the task's event stream was shown.
export interface StreamReport {
  // At the end the view shows exactly the written conversation, each message once, and no draft.
  consistent: boolean;
  drafts: DraftRecord[];
}

export interface ScenarioResult {
  scenario: string;
  runId: string;
  // The expected end category was reached, every business assertion holds, every planned fault
  // fired (a run that was never disturbed proves nothing about recovery), and a watched stream
  // ended consistent.
  passed: boolean;
  outcome: { expected: OutcomeCategory; actual: OutcomeCategory | null; achieved: boolean };
  conversation: Conversation;
  assertions: AssertionResult[];
  faults: FaultReport[];
  // Only when the stream was watched.
  stream?: StreamReport;
}

export async function runScenario(
  scenario: Scenario,
  environment: ScenarioEnvironment,
  options: RunOptions = {},
): Promise<ScenarioResult> {
  const now = environment.now ?? (() => new Date());
  const faultPlan = options.faultPlan ?? [];
  await resetBusinessMock(environment.businessMockUrl, {
    seed: scenario.seed,
    fixture: businessFixture(scenario.business, now()),
  });
  const run = await createRun(environment.executionDb, {
    scenario: scenario.name,
    config: { model: { kind: "scripted", turns: scenario.model.turns }, faultPlan },
  });
  const watched: { stream?: TaskStream } = {};
  let conversation: Conversation;
  let stream: StreamReport | undefined;
  try {
    conversation = await converse(taskApi(environment.taskApiUrl), scenario.simulatedUser, {
      runId: run.id,
      pollIntervalMs: environment.pollIntervalMs ?? 100,
      turnTimeoutMs: environment.turnTimeoutMs ?? 60_000,
      ...(options.watchStream === true
        ? {
            onTaskCreated: async (taskId: string) => {
              watched.stream = await followTask(environment.taskApiUrl, taskId);
            },
          }
        : {}),
    });
    if (watched.stream !== undefined) {
      stream = await judgeStream(watched.stream, conversation.messages);
    }
  } finally {
    await watched.stream?.close().catch(() => {});
  }
  const assertions = await checkBusinessAssertions(
    environment.business.db,
    scenario.expected.business,
    new Set(scenario.business.aftersales.map((record) => record.id)),
  );
  const faults = await reportFaults(environment.executionDb, run.id, faultPlan);
  const actual = outcomeOf(conversation);
  const achieved = actual === scenario.expected.outcome;
  return {
    scenario: scenario.name,
    runId: run.id,
    passed:
      achieved &&
      assertions.every((result) => result.passed) &&
      faults.every((fault) => fault.fired) &&
      (stream === undefined || stream.consistent),
    outcome: { expected: scenario.expected.outcome, actual, achieved },
    conversation,
    assertions,
    faults,
    ...(stream === undefined ? {} : { stream }),
  };
}

const streamSettleMs = 5000;

// `written` is the conversation as the task API lists it at the end. Each message event trails
// the commit it announces, so the stream is read until it has caught up or time is up.
async function judgeStream(stream: TaskStream, written: MessageView[]): Promise<StreamReport> {
  const giveUpAt = Date.now() + streamSettleMs;
  while (viewOf(stream.events).messages.length < written.length && Date.now() < giveUpAt) {
    await sleep(20);
  }
  await stream.close();
  const view = viewOf(stream.events);
  return {
    consistent: view.draft === null && canonicalJson(view.messages) === canonicalJson(written),
    drafts: view.drafts,
  };
}

// Only "auto_completed" can be told apart so far: reconfirmed, stopped and handed_off need the
// dispositions and handoffs the kernel does not record yet.
function outcomeOf(conversation: Conversation): OutcomeCategory | null {
  return conversation.ended === "script_completed" ? "auto_completed" : null;
}
