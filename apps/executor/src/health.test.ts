import type { AddressInfo } from "node:net";
import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { afterEach, expect, test } from "vitest";
import { createHealthServer } from "./health.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function getHealth(connectionString: string): Promise<Response> {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const server = createHealthServer(pool);
  cleanups.push(async () => {
    server.close();
    await pool.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/health`);
}

test("health is ok when the execution database is reachable", async () => {
  const response = await getHealth(requireEnv("EXECUTION_DATABASE_URL"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("health is unavailable when the execution database is unreachable", async () => {
  const response = await getHealth("postgres://execution:execution@127.0.0.1:1/execution");

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
});
