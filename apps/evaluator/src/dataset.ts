import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario, type Scenario } from "./scenario.ts";
import { type ScenarioFile, scenarioTemplates } from "./scenario-templates.ts";

// The development set is for tuning, the test set for the experiment. Every variant of every
// template appears in both: once in the development set and twice in the test set, each time
// with other facts.
export const scenarioSets = { dev: 1, test: 2 } as const;
export type ScenarioSet = keyof typeof scenarioSets;

export interface GeneratedScenario {
  template: string;
  variant: string;
  scenario: ScenarioFile;
}

export type Dataset = Record<ScenarioSet, GeneratedScenario[]>;

export function generateDataset(): Dataset {
  const generate = (set: ScenarioSet) =>
    scenarioTemplates.flatMap((template) =>
      template.variants.flatMap((variant) =>
        Array.from({ length: scenarioSets[set] }, (_, k) => ({
          template: template.name,
          variant: variant.name,
          scenario: variant.build(`${set}-${template.name}-${variant.name}-${k + 1}`),
        })),
      ),
    );
  return { dev: generate("dev"), test: generate("test") };
}

// Where a set's scenario files are committed, one file per scenario.
export function scenarioSetDirectory(set: ScenarioSet): string {
  return join(import.meta.dirname, "../scenarios", set);
}

export function scenarioPath(directory: string, name: string): string {
  return join(directory, `${name}.json`);
}

export async function scenarioFileNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
}

export async function loadScenarioSet(directory: string): Promise<Scenario[]> {
  const files = await scenarioFileNames(directory);
  return Promise.all(files.map((file) => loadScenario(join(directory, file))));
}

// Replaces each set's files with the generated ones; returns the paths written.
export async function writeDataset(dataset: Dataset): Promise<string[]> {
  const written: string[] = [];
  for (const set of Object.keys(scenarioSets) as ScenarioSet[]) {
    const directory = scenarioSetDirectory(set);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    for (const { scenario } of dataset[set]) {
      const path = scenarioPath(directory, scenario.name);
      await writeFile(path, `${JSON.stringify(scenario)}\n`);
      written.push(path);
    }
  }
  return written;
}
