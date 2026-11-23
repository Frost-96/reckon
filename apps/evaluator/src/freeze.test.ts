import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAftersalesPackage } from "@reckon/aftersales";
import type { BusinessPackage } from "@reckon/kernel";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  defaultFreezeOptions,
  type FreezeOptions,
  freezeTestSet,
  generateDataset,
  type ScenarioFile,
  verifyFreeze,
  verifyFreezeBeforeRun,
} from "./index.ts";

const aftersales = createAftersalesPackage({ businessServiceUrl: "http://business.invalid" });
const dataset = generateDataset();

function testScenario(index: number): ScenarioFile {
  const generated = dataset.test[index];
  if (generated === undefined) {
    throw new Error(`No test scenario #${index}`);
  }
  return generated.scenario;
}

const [first, second, third] = [testScenario(0), testScenario(1), testScenario(2)];
const devScenario = dataset.dev[0]?.scenario;

let directory: string;
let options: FreezeOptions;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reckon-freeze-"));
  options = {
    recordPath: join(directory, "freeze.json"),
    testSetDirectory: join(directory, "test"),
    businessPackage: aftersales,
  };
  await writeScenarios(options.testSetDirectory, [first, second]);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeScenarios(at: string, scenarios: readonly (ScenarioFile | undefined)[]) {
  await mkdir(at, { recursive: true });
  for (const scenario of scenarios) {
    await writeFile(join(at, `${scenario?.name}.json`), `${JSON.stringify(scenario)}\n`);
  }
}

function withTool(name: string, change: (tool: BusinessPackage["tools"][number]) => object) {
  return {
    ...aftersales,
    tools: aftersales.tools.map((tool) =>
      tool.name === name ? { ...tool, ...change(tool) } : tool,
    ),
  } as BusinessPackage;
}

test("without a freeze record nothing is frozen", async () => {
  expect(await verifyFreeze(options)).toEqual({ frozen: false });
});

test("a freeze records a hash of each test scenario, the prompt and the tool definitions, and verifies as unchanged", async () => {
  const record = await freezeTestSet(options);

  expect(Object.keys(record.testSet).sort()).toEqual([first.name, second.name].sort());
  expect(record.systemPrompt).toMatch(/^[0-9a-f]{64}$/);
  expect(record.toolDefinitions).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(await readFile(options.recordPath, "utf8"))).toEqual(record);
  expect(await verifyFreeze(options)).toEqual({ frozen: true, record, changes: [] });
});

test.each([
  [
    "the prompt",
    () => ({ businessPackage: { ...aftersales, systemPrompt: `${aftersales.systemPrompt}\n` } }),
    [{ what: "systemPrompt" }],
  ],
  [
    "a tool description",
    () => ({ businessPackage: withTool("query_order", () => ({ description: "查订单" })) }),
    [{ what: "toolDefinitions" }],
  ],
  [
    "a tool's parameters",
    () => ({
      businessPackage: withTool("query_aftersales_rules", (tool) => ({
        parameters: tool.parameters.describe("改过的说明"),
      })),
    }),
    [{ what: "toolDefinitions" }],
  ],
])("changing %s after the freeze is reported", async (_what, change, expected) => {
  await freezeTestSet(options);

  const check = await verifyFreeze({ ...options, ...change() });

  expect(check).toMatchObject({ frozen: true, changes: expected });
});

test("editing, adding or removing a test scenario after the freeze is reported by name; reformatting it is not", async () => {
  await freezeTestSet(options);
  const firstPath = join(options.testSetDirectory, `${first.name}.json`);
  await writeFile(firstPath, JSON.stringify(first, null, 4));
  expect(await verifyFreeze(options)).toMatchObject({ changes: [] });

  await writeFile(firstPath, JSON.stringify({ ...first, description: "改过的场景" }));
  await rm(join(options.testSetDirectory, `${second.name}.json`));
  await writeScenarios(options.testSetDirectory, [third]);

  expect(await verifyFreeze(options)).toMatchObject({
    frozen: true,
    changes: expect.arrayContaining([
      { what: "scenario", name: first.name, change: "changed" },
      { what: "scenario", name: second.name, change: "removed" },
      { what: "scenario", name: third.name, change: "added" },
    ]),
  });
});

test("a run of a frozen test scenario is refused once anything frozen changed, also from a copy elsewhere; other runs are not", async () => {
  await freezeTestSet(options);
  const changedPrompt = {
    ...options,
    businessPackage: { ...aftersales, systemPrompt: "另一个提示词" },
  };
  const elsewhere = join(directory, "elsewhere");
  await writeScenarios(elsewhere, [{ ...first, description: "改过的场景" }, devScenario]);
  const testScenario = join(options.testSetDirectory, `${first.name}.json`);

  expect(await verifyFreezeBeforeRun(testScenario, options)).toEqual([]);
  expect(await verifyFreezeBeforeRun(testScenario, changedPrompt)).toEqual([
    { what: "systemPrompt" },
  ]);
  expect(await verifyFreezeBeforeRun(join(elsewhere, `${first.name}.json`), options)).toEqual([
    { what: "scenario", name: first.name, change: "changed" },
  ]);
  expect(
    await verifyFreezeBeforeRun(join(elsewhere, `${devScenario?.name}.json`), changedPrompt),
  ).toEqual([]);
});

// Once the test set is frozen (#29), changing the prompt, a tool or a test scenario without
// freezing again fails the suite.
const committed = defaultFreezeOptions();
test.skipIf(!existsSync(committed.recordPath))(
  "the committed freeze record matches the committed test set, prompt and tool definitions",
  async () => {
    expect(await verifyFreeze(committed)).toMatchObject({ frozen: true, changes: [] });
  },
);
