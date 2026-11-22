import { defineConfig } from "vitest/config";

const postgresPort = process.env.POSTGRES_PORT ?? "5432";
const executionPassword = encodeURIComponent(process.env.EXECUTION_DB_PASSWORD ?? "execution");
const businessPassword = encodeURIComponent(process.env.BUSINESS_DB_PASSWORD ?? "business");
const postgresPassword = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "postgres");

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts"],
    env: {
      POSTGRES_ADMIN_URL: `postgres://postgres:${postgresPassword}@localhost:${postgresPort}/postgres`,
      EXECUTION_DATABASE_URL: `postgres://execution:${executionPassword}@localhost:${postgresPort}/execution`,
      BUSINESS_DATABASE_URL: `postgres://business:${businessPassword}@localhost:${postgresPort}/business`,
    },
  },
});
