import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InvalidScenarioError, parseScenario } from "./index.ts";

const returnOneKettle = join(import.meta.dirname, "../scenarios/return-one-kettle.json");

async function scenarioJson() {
  return JSON.parse(await readFile(returnOneKettle, "utf8"));
}

test("a scenario whose expected outcome is not an end category is refused, naming the field", async () => {
  const scenario = await scenarioJson();
  const invalid = { ...scenario, expected: { ...scenario.expected, outcome: "done" } };

  expect(() => parseScenario(invalid, "broken.json")).toThrow(InvalidScenarioError);
  expect(() => parseScenario(invalid, "broken.json")).toThrow(/expected\.outcome/);
});

test("a misspelled business assertion is refused rather than left unchecked", async () => {
  const scenario = await scenarioJson();
  const [first, ...rest] = scenario.expected.business;
  const { returnShipment, ...withoutShipment } = first;
  const misspelled = { ...withoutShipment, returnShipments: returnShipment };
  const invalid = {
    ...scenario,
    expected: { ...scenario.expected, business: [misspelled, ...rest] },
  };

  expect(() => parseScenario(invalid, "broken.json")).toThrow(/returnShipments/);
});
