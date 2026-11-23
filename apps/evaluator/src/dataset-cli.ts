import { execFileSync } from "node:child_process";
import { generateDataset, scenarioSetDirectory, writeDataset } from "./dataset.ts";
import {
  defaultFreezeOptions,
  describeFreezeChange,
  freezeTestSet,
  verifyFreeze,
} from "./freeze.ts";

// pnpm dataset generate: rewrites the development and test set files from the templates.
// pnpm dataset freeze:   records the hashes of the test set, the prompt and the tool definitions.
// pnpm dataset verify:   exit 0 when none of them changed since the freeze, 1 when something
//                        did, 2 when there is no freeze yet.

const usage = "Usage: pnpm dataset generate | freeze | verify";
const [command, ...extra] = process.argv.slice(2);
if (extra.length > 0) {
  console.error(usage);
  process.exit(2);
}

switch (command) {
  case "generate": {
    const written = await writeDataset(generateDataset());
    // Formatted as the linter wants it, so the committed files pass `pnpm lint`.
    execFileSync(
      "pnpm",
      [
        "exec",
        "biome",
        "format",
        "--write",
        scenarioSetDirectory("dev"),
        scenarioSetDirectory("test"),
      ],
      { stdio: "inherit" },
    );
    console.log(`Wrote ${written.length} scenario files.`);
    break;
  }
  case "freeze": {
    const options = defaultFreezeOptions();
    const record = await freezeTestSet(options);
    console.log(
      `Froze ${Object.keys(record.testSet).length} test scenarios, the prompt and the tool definitions in ${options.recordPath}.`,
    );
    break;
  }
  case "verify": {
    const check = await verifyFreeze(defaultFreezeOptions());
    if (!check.frozen) {
      console.error("The test set is not frozen yet: run `pnpm dataset freeze`.");
      process.exit(2);
    }
    for (const change of check.changes) {
      console.error(`Changed since the freeze: ${describeFreezeChange(change)}`);
    }
    if (check.changes.length > 0) {
      process.exit(1);
    }
    console.log("The test set, the prompt and the tool definitions are as frozen.");
    break;
  }
  default:
    console.error(usage);
    process.exit(2);
}
