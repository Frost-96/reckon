import { defineConfig } from "vitest/config";

const postgresPort = process.env.POSTGRES_PORT ?? "5432";
const executionPassword = encodeURIComponent(process.env.EXECUTION_DB_PASSWORD ?? "execution");
const businessPassword = encodeURIComponent(process.env.BUSINESS_DB_PASSWORD ?? "business");

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts"],
    env: {
      EXECUTION_DATABASE_URL: `postgres://execution:${executionPassword}@localhost:${postgresPort}/execution`,
      BUSINESS_DATABASE_URL: `postgres://business:${businessPassword}@localhost:${postgresPort}/business`,
    },
  },
});
