import { readFile } from "node:fs/promises";
import { canonicalJson } from "@reckon/shared";
import { expect, test } from "vitest";
import {
  type GeneratedScenario,
  generateDataset,
  loadScenarioSet,
  parseScenario,
  type Scenario,
  scenarioPath,
  scenarioSetDirectory,
} from "./index.ts";
import { expectsWantedReturnWritten, wantedReturnOf } from "./test-support.ts";

const dataset = generateDataset();
const all = [...dataset.dev, ...dataset.test];

function scenariosOf(template: string, entries: readonly GeneratedScenario[] = all): Scenario[] {
  return entries
    .filter((entry) => entry.template === template)
    .map(({ scenario }) => parseScenario(scenario));
}

function openingOf(scenario: Scenario): string {
  return scenario.simulatedUser.messages[0] ?? "";
}

test("the generator yields a development set of 20 and a test set of 40, every scenario valid and uniquely named", () => {
  expect(dataset.dev).toHaveLength(20);
  expect(dataset.test).toHaveLength(40);
  for (const { scenario } of all) {
    expect(() => parseScenario(scenario, scenario.name)).not.toThrow();
  }
  expect(new Set(all.map(({ scenario }) => scenario.name)).size).toBe(60);
});

test("each template has several variants, each in the development set once and the test set twice, never with the same facts", () => {
  const variants = (entries: readonly GeneratedScenario[]) =>
    entries.map(({ template, variant }) => `${template}/${variant}`);
  const distinct = [...new Set(variants(all))];

  expect([...new Set(all.map(({ template }) => template))]).toEqual([
    "complete-info",
    "follow-up",
    "candidate-orders",
    "eligibility",
  ]);
  for (const template of new Set(all.map((entry) => entry.template))) {
    expect(distinct.filter((name) => name.startsWith(`${template}/`)).length).toBeGreaterThan(2);
  }
  expect(variants(dataset.dev).sort()).toEqual([...distinct].sort());
  expect(variants(dataset.test).sort()).toEqual([...distinct, ...distinct].sort());
  const facts = all.map(({ scenario: { name: _, seed: __, ...facts } }) => canonicalJson(facts));
  expect(new Set(facts).size).toBe(60);
});

test("complete-info openings say order, product, quantity and reason; follow-up openings leave some of it out", () => {
  const mentions = (scenario: Scenario) => {
    const opening = openingOf(scenario);
    const wanted = wantedReturnOf(scenario);
    return [
      opening.includes(wanted.orderId),
      opening.includes(wanted.productName),
      opening.includes(`${wanted.quantity} 件`),
      opening.includes(wanted.reason),
    ];
  };

  for (const scenario of scenariosOf("complete-info")) {
    expect(mentions(scenario), scenario.name).toEqual([true, true, true, true]);
  }
  for (const scenario of scenariosOf("follow-up")) {
    expect(mentions(scenario), scenario.name).toContain(false);
  }
});

test("in candidate-orders scenarios the customer does not name the order and bought the product in more than one", () => {
  for (const scenario of scenariosOf("candidate-orders")) {
    const wanted = wantedReturnOf(scenario);
    const candidates = scenario.business.orders.filter(
      (order) =>
        order.customerId === scenario.simulatedUser.customerId &&
        order.lines.some((line) => line.productName === wanted.productName),
    );

    expect(openingOf(scenario), scenario.name).not.toContain(wanted.orderId);
    expect(candidates.length, scenario.name).toBeGreaterThan(1);
  }
});

// The files are what gets reviewed, run and frozen; they must not drift from their templates.
test("the committed scenario files of both sets are exactly what the generator produces", async () => {
  for (const set of ["dev", "test"] as const) {
    const committed = await loadScenarioSet(scenarioSetDirectory(set));

    expect(committed.map(({ name }) => name).sort(), set).toEqual(
      dataset[set].map(({ scenario }) => scenario.name).sort(),
    );
    for (const { scenario } of dataset[set]) {
      const file = await readFile(scenarioPath(scenarioSetDirectory(set), scenario.name), "utf8");
      expect(JSON.parse(file), scenario.name).toEqual(scenario);
    }
  }
});

test("eligibility scenarios in each set include returns that are written and returns that are not", () => {
  for (const entries of [dataset.dev, dataset.test]) {
    const written = scenariosOf("eligibility", entries).map(expectsWantedReturnWritten);

    expect(written).toContain(true);
    expect(written).toContain(false);
  }
});
