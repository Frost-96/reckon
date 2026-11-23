import { inMinutes } from "@reckon/business-mock/test-support";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { generateDataset, parseScenario, runScenario } from "./index.ts";
import { businessFixture } from "./scenario.ts";
import {
  expectsWantedReturnWritten,
  type StackUnderTest,
  startStackUnderTest,
} from "./test-support.ts";

let stack: StackUnderTest;

beforeAll(async () => {
  stack = await startStackUnderTest();
});

afterAll(async () => {
  await stack.close();
});

const dataset = generateDataset();
const generated = [...dataset.dev, ...dataset.test].map(({ scenario }) => parseScenario(scenario));

// Each scenario's scripted model follows its template, so the whole dataset runs before a real
// model exists, and each run proves the expectations hold against the real business service.
test.each(generated.map((scenario) => [scenario.name, scenario] as const))(
  "%s passes with its scripted model",
  async (_name, scenario) => {
    const result = await runScenario(scenario, stack.environment);

    expect(result.conversation.ended).toBe("script_completed");
    expect(result.assertions.filter((assertion) => !assertion.passed)).toEqual([]);
    expect(result.passed).toBe(true);
  },
);

// A run that writes nothing proves little on its own: the agent may simply not have tried.
test.each(
  generated
    .filter((scenario) => !expectsWantedReturnWritten(scenario))
    .map((scenario) => [scenario.name, scenario] as const),
)(
  "%s: the business service itself refuses the return the customer wants",
  async (_name, scenario) => {
    await stack.mock.reset(scenario.seed, businessFixture(scenario.business, new Date()));
    const parameters = z
      .record(z.string(), z.unknown())
      .parse(scenario.simulatedUser.confirmations[0]?.parameters);

    const response = await stack.mock.app.inject({
      method: "POST",
      url: "/aftersales",
      headers: { "idempotency-key": "probe" },
      payload: {
        customerId: scenario.simulatedUser.customerId,
        ...parameters,
        clientRef: "probe",
        deadline: inMinutes(5),
      },
    });

    expect(response.statusCode, response.body).toBe(422);
  },
);
