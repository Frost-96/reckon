import { requireEnv } from "@reckon/shared";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterEach, expect, test } from "vitest";
import { buildApp } from "./app.ts";

const pools: pg.Pool[] = [];
const apps: FastifyInstance[] = [];

function appFor(connectionString: string): FastifyInstance {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  pools.push(pool);
  const app = buildApp(pool);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

test("health is ok when the execution database is reachable", async () => {
  const app = appFor(requireEnv("EXECUTION_DATABASE_URL"));

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });
});

test("health is unavailable when the execution database is unreachable", async () => {
  const app = appFor("postgres://execution:execution@127.0.0.1:1/execution");

  const response = await app.inject({ method: "GET", url: "/health" });

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: "unavailable" });
});
