import { defineConfig } from "drizzle-kit";

const port = process.env.POSTGRES_PORT ?? "5432";
const password = encodeURIComponent(process.env.BUSINESS_DB_PASSWORD ?? "business");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      process.env.BUSINESS_DATABASE_URL ??
      `postgres://business:${password}@localhost:${port}/business`,
  },
});
