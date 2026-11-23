import { execFileSync } from "node:child_process";
import { generateDataset, scenarioSetDirectory, writeDataset } from "./dataset.ts";

// pnpm dataset generate: rewrites the development and test set files from the templates.

const usage = "Usage: pnpm dataset generate";
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
  default:
    console.error(usage);
    process.exit(2);
}
