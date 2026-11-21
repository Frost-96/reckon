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

test("health is ok when the execution database is reachable", async () => {
  const app = buildApp(poolFor(requireEnv("EXECUTION_DATABASE_URL")));

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });
});

test("health is unavailable when the execution database is unreachable", async () => {
  const app = buildApp(poolFor("postgres://execution:execution@127.0.0.1:1/execution"));

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: "unavailable" });
});
