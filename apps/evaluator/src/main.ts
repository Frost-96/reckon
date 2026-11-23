import { parseArgs } from "node:util";
import {
  connectExecutionDb,
  faultPointNames,
  type PlannedFault,
  parseFaultPointLabel,
} from "@reckon/kernel";
import pg from "pg";
import { connectBusinessReader } from "./business-assertions.ts";
import { defaultFreezeOptions, describeFreezeChange, verifyFreezeBeforeRun } from "./freeze.ts";
import { runScenario } from "./run-scenario.ts";
import { InvalidScenarioError, loadScenario } from "./scenario.ts";

// Runs one scenario against a running experiment stack and prints the result as JSON. Exit code
// 0 when it passed, 1 when it did not, 2 when it could not be run as asked (also: a frozen test
// scenario whose frozen content changed).
// Defaults reach a stack started by `docker compose --profile experiment` with the same port
// variables. Each --fault adds a fault point to the run's fault plan, e.g.
// --fault after_write_confirmed:create_aftersales (point, then optionally the tool or operation).

const usage = `Usage: pnpm scenario <scenario.json> [--fault <point>[:<target>]]...
Fault points: ${faultPointNames.join(", ")}`;

function fail(message: string): never {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

function parseCommandLine() {
  return parseArgs({
    allowPositionals: true,
    options: { fault: { type: "string", multiple: true, default: [] } },
  });
}

let args: ReturnType<typeof parseCommandLine>;
try {
  args = parseCommandLine();
} catch (error) {
  fail(String(error));
}
const [path, ...extra] = args.positionals;
if (path === undefined || extra.length > 0) {
  fail("Give exactly one scenario file.");
}
const faultPlan: PlannedFault[] = args.values.fault.map((label) => {
  try {
    return parseFaultPointLabel(label);
  } catch {
    return fail(`Unknown fault point ${label}.`);
  }
});

const env = process.env;
const postgres = `localhost:${env.POSTGRES_PORT ?? "5432"}`;
const password = (name: string, fallback: string) => encodeURIComponent(env[name] ?? fallback);
const executionDatabaseUrl =
  env.EXECUTION_DATABASE_URL ??
  `postgres://execution:${password("EXECUTION_DB_PASSWORD", "execution")}@${postgres}/execution`;
// The business reader role may only select.
const businessReaderDatabaseUrl =
  env.BUSINESS_READER_DATABASE_URL ??
  `postgres://business_reader:${password("BUSINESS_READER_DB_PASSWORD", "business_reader")}@${postgres}/business`;

let scenario: Awaited<ReturnType<typeof loadScenario>>;
try {
  scenario = await loadScenario(path);
} catch (error) {
  console.error(error instanceof InvalidScenarioError ? error.message : error);
  process.exit(2);
}

// A frozen test scenario is not run once anything frozen has changed.
const frozenChanges = await verifyFreezeBeforeRun(path, defaultFreezeOptions());
if (frozenChanges.length > 0) {
  for (const change of frozenChanges) {
    console.error(`Changed since the freeze: ${describeFreezeChange(change)}`);
  }
  console.error("Refusing to run a frozen test scenario: freeze again (and re-record) first.");
  process.exit(2);
}

const executionPool = new pg.Pool({ connectionString: executionDatabaseUrl });
const business = connectBusinessReader(businessReaderDatabaseUrl);
try {
  const result = await runScenario(
    scenario,
    {
      taskApiUrl: env.TASK_API_URL ?? `http://localhost:${env.API_PORT ?? "3000"}`,
      businessMockUrl:
        env.BUSINESS_MOCK_URL ?? `http://localhost:${env.BUSINESS_MOCK_PORT ?? "3100"}`,
      executionDb: connectExecutionDb(executionPool),
      business,
    },
    { faultPlan },
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await executionPool.end();
  await business.close();
}
