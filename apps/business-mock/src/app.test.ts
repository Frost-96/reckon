import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "./app.ts";

const pools: pg.Pool[] = [];

function poolFor(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

test("health is ok when the business database is reachable", async () => {
  const app = buildApp(poolFor(requireEnv("BUSINESS_DATABASE_URL")));

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });
});

test("health is unavailable when the business database is unreachable", async () => {
  const app = buildApp(poolFor("postgres://business:business@127.0.0.1:1/business"));

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: "unavailable" });
});
