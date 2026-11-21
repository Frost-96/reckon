import { defineConfig } from "vitest/config";

const postgresPort = process.env.POSTGRES_PORT ?? "5432";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts"],
    env: {
      EXECUTION_DATABASE_URL: `postgres://execution:execution@localhost:${postgresPort}/execution`,
      BUSINESS_DATABASE_URL: `postgres://business:business@localhost:${postgresPort}/business`,
    },
  },
});
