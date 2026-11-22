import { defineConfig } from "drizzle-kit";

const port = process.env.POSTGRES_PORT ?? "5432";
const password = encodeURIComponent(process.env.EXECUTION_DB_PASSWORD ?? "execution");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      process.env.EXECUTION_DATABASE_URL ??
      `postgres://execution:${password}@localhost:${port}/execution`,
  },
});
