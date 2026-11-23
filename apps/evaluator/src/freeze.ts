import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAftersalesPackage } from "@reckon/aftersales";
import { type BusinessPackage, modelToolDefinitions } from "@reckon/kernel";
import { canonicalHash } from "@reckon/shared";
import { z } from "zod";
import { scenarioFileNames, scenarioSetDirectory } from "./dataset.ts";

// Before the main experiment with the real model, the test set, the prompt and the tool
// definitions are frozen: their hashes are committed, and a run of a test scenario checks them,
// so nothing is tuned on the test set afterwards.

const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const freezeRecordSchema = z
  .object({
    // By scenario name: the hash of the scenario file's JSON content, formatting aside.
    testSet: z.record(z.string(), hash),
    systemPrompt: hash,
    // Of the definitions the model is sent, the kernel's built-ins included.
    toolDefinitions: hash,
  })
  .strict();

export type FreezeRecord = z.output<typeof freezeRecordSchema>;

export type FreezeChange =
  | { what: "systemPrompt" | "toolDefinitions" }
  | { what: "scenario"; name: string; change: "changed" | "added" | "removed" };

export type FreezeCheck =
  | { frozen: false }
  | { frozen: true; record: FreezeRecord; changes: FreezeChange[] };

export interface FreezeOptions {
  recordPath: string;
  testSetDirectory: string;
  // Whose prompt and tool definitions are frozen.
  businessPackage: BusinessPackage;
}

// The committed record, test set and the aftersales package.
export function defaultFreezeOptions(): FreezeOptions {
  return {
    recordPath: join(import.meta.dirname, "../scenarios/freeze.json"),
    testSetDirectory: scenarioSetDirectory("test"),
    // Prompt and tool definitions do not depend on where the business service is.
    businessPackage: createAftersalesPackage({ businessServiceUrl: "http://business.invalid" }),
  };
}

const named = z.object({ name: z.string() }).loose();

// A scenario file's name and the hash of its content; formatting does not count.
async function hashScenarioFile(path: string): Promise<{ name: string; hash: string }> {
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  return { name: named.parse(json).name, hash: canonicalHash(json) };
}

async function currentRecord(options: FreezeOptions): Promise<FreezeRecord> {
  const testSet: Record<string, string> = {};
  for (const file of await scenarioFileNames(options.testSetDirectory)) {
    const scenario = await hashScenarioFile(join(options.testSetDirectory, file));
    testSet[scenario.name] = scenario.hash;
  }
  return {
    testSet,
    systemPrompt: canonicalHash(options.businessPackage.systemPrompt),
    toolDefinitions: canonicalHash(modelToolDefinitions(options.businessPackage)),
  };
}

export async function freezeTestSet(options: FreezeOptions): Promise<FreezeRecord> {
  const record = await currentRecord(options);
  await writeFile(options.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function readRecord(path: string): Promise<FreezeRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return freezeRecordSchema.parse(JSON.parse(text));
}

function compare(frozen: FreezeRecord, current: FreezeRecord): FreezeChange[] {
  const changes: FreezeChange[] = [];
  for (const what of ["systemPrompt", "toolDefinitions"] as const) {
    if (frozen[what] !== current[what]) {
      changes.push({ what });
    }
  }
  for (const [name, frozenHash] of Object.entries(frozen.testSet)) {
    const currentHash = current.testSet[name];
    if (currentHash !== frozenHash) {
      changes.push({
        what: "scenario",
        name,
        change: currentHash === undefined ? "removed" : "changed",
      });
    }
  }
  for (const name of Object.keys(current.testSet)) {
    if (!(name in frozen.testSet)) {
      changes.push({ what: "scenario", name, change: "added" });
    }
  }
  return changes;
}

export async function verifyFreeze(options: FreezeOptions): Promise<FreezeCheck> {
  const record = await readRecord(options.recordPath);
  if (record === undefined) {
    return { frozen: false };
  }
  return { frozen: true, record, changes: compare(record, await currentRecord(options)) };
}

// What forbids running this scenario file: nothing unless it is a scenario of the frozen test
// set (by name, wherever the file is); then any change to the frozen content, the file itself
// included.
export async function verifyFreezeBeforeRun(
  scenarioPath: string,
  options: FreezeOptions,
): Promise<FreezeChange[]> {
  const check = await verifyFreeze(options);
  const { name, hash: fileHash } = await hashScenarioFile(scenarioPath);
  const frozenHash = check.frozen ? check.record.testSet[name] : undefined;
  if (!check.frozen || frozenHash === undefined) {
    return [];
  }
  const changes = [...check.changes];
  const listed = changes.some((change) => change.what === "scenario" && change.name === name);
  if (fileHash !== frozenHash && !listed) {
    changes.push({ what: "scenario", name, change: "changed" });
  }
  return changes;
}

export function describeFreezeChange(change: FreezeChange): string {
  switch (change.what) {
    case "systemPrompt":
      return "the system prompt changed";
    case "toolDefinitions":
      return "the tool definitions changed";
    case "scenario":
      return `test scenario ${change.name} was ${change.change}`;
  }
}
