import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "./app.ts";
import { type BusinessMockUnderTest, inMinutes, startBusinessMock } from "./test-support.ts";

let mock: BusinessMockUnderTest;

beforeAll(async () => {
  mock = await startBusinessMock();
});

afterAll(async () => {
  await mock.close();
});

function write(url: string, key: string, payload: Record<string, unknown>) {
  return mock.app.inject({
    method: "POST",
    url,
    headers: { "idempotency-key": key },
    payload: { customerId: "C1", clientRef: key, deadline: inMinutes(5), ...payload },
  });
}

async function submitReturn(createKey: string, shipKey: string) {
  const aftersales = await write("/aftersales", createKey, {
    orderId: "O1",
    lineId: "L1",
    quantity: 1,
    reason: "Arrived broken",
    returnFeeCents: 800,
  });
  const shipment = await write(`/aftersales/${aftersales.json().id}/return-shipments`, shipKey, {});
  return { aftersalesId: aftersales.json().id, shipmentId: shipment.json().id };
}

test("document numbers are the same on every run of a scenario", async () => {
  await mock.reset("seed-1");
  const firstRun = await submitReturn("op-create-1", "op-ship-1");

  await mock.reset("seed-1");
  const secondRun = await submitReturn("op-create-1", "op-ship-1");

  expect(secondRun).toEqual(firstRun);
  expect(firstRun.aftersalesId).toMatch(/^AS-/);
  expect(firstRun.shipmentId).toMatch(/^RS-/);
});

test("document numbers differ between scenario seeds and between operations", async () => {
  await mock.reset("seed-1");
  const seed1 = await submitReturn("op-create-1", "op-ship-1");

  await mock.reset("seed-2");
  const seed2 = await submitReturn("op-create-1", "op-ship-1");
  await mock.reset("seed-1");
  const otherOperation = await submitReturn("op-create-9", "op-ship-9");

  expect(seed2.aftersalesId).not.toBe(seed1.aftersalesId);
  expect(otherOperation.aftersalesId).not.toBe(seed1.aftersalesId);
  expect(otherOperation.shipmentId).not.toBe(seed1.shipmentId);
});

test("reset wipes earlier writes and frees their idempotency keys", async () => {
  await mock.reset("seed-1");
  await submitReturn("op-create-1", "op-ship-1");

  await mock.reset("seed-1");
  const afterReset = await mock.app.inject({ method: "GET", url: "/customers/C1/aftersales" });
  const reused = await write("/aftersales", "op-create-1", {
    orderId: "O1",
    lineId: "L1",
    quantity: 2,
    reason: "Changed my mind",
    returnFeeCents: 800,
  });

  expect(afterReset.json()).toEqual([]);
  expect(reused.statusCode).toBe(201);
});

test("reset restores the default idempotency mode and switches", async () => {
  await mock.reset("seed-1");
  await mock.configure({ checkFee: false, processingDelayMs: 250 });

  await mock.reset("seed-2");
  const config = await mock.app.inject({ method: "GET", url: "/admin/config" });

  expect(config.json()).toEqual({
    scenarioSeed: "seed-2",
    idempotencyMode: "key",
    checkFee: true,
    processingDelayMs: 0,
  });
});

test("the admin interface does not exist unless enabled", async () => {
  const pool = new pg.Pool({ connectionString: requireEnv("BUSINESS_DATABASE_URL") });
  const app = buildApp({ pool });
  try {
    const reset = await app.inject({ method: "POST", url: "/admin/reset", payload: {} });
    const config = await app.inject({ method: "PATCH", url: "/admin/config", payload: {} });

    expect([reset.statusCode, config.statusCode]).toEqual([404, 404]);
  } finally {
    await app.close();
    await pool.end();
  }
});
