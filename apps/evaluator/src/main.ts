import { connectExecutionDb } from "@reckon/kernel";
import pg from "pg";
import { connectBusinessReader } from "./business-assertions.ts";
import { runScenario } from "./run-scenario.ts";
import { InvalidScenarioError, loadScenario } from "./scenario.ts";

// Runs one scenario against a running stack and prints the result as JSON. Exit code 0 when it
// passed, 1 when it did not, 2 when it could not be run as asked.
// Defaults reach a stack started by `docker compose` with the same port variables.

const [path, ...extra] = process.argv.slice(2);
if (path === undefined || extra.length > 0) {
  console.error("Usage: pnpm scenario <scenario.json>");
  process.exit(2);
}

const env = process.env;
const postgres = `localhost:${env.POSTGRES_PORT ?? "5432"}`;
const password = (name: string, fallback: string) => encodeURIComponent(env[name] ?? fallback);
const executionDatabaseUrl =
  env.EXECUTION_DATABASE_URL ??
  `postgres://execution:${password("EXECUTION_DB_PASSWORD", "execution")}@${postgres}/execution`;
const businessDatabaseUrl =
  env.BUSINESS_DATABASE_URL ??
  `postgres://business:${password("BUSINESS_DB_PASSWORD", "business")}@${postgres}/business`;

let scenario: Awaited<ReturnType<typeof loadScenario>>;
try {
  scenario = await loadScenario(path);
} catch (error) {
  console.error(error instanceof InvalidScenarioError ? error.message : error);
  process.exit(2);
}

const executionPool = new pg.Pool({ connectionString: executionDatabaseUrl });
const business = connectBusinessReader(businessDatabaseUrl);
try {
  const result = await runScenario(scenario, {
    taskApiUrl: env.TASK_API_URL ?? `http://localhost:${env.API_PORT ?? "3000"}`,
    businessMockUrl:
      env.BUSINESS_MOCK_URL ?? `http://localhost:${env.BUSINESS_MOCK_PORT ?? "3100"}`,
    executionDb: connectExecutionDb(executionPool),
    business,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await executionPool.end();
  await business.close();
}
