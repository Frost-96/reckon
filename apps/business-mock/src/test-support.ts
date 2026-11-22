import { requireEnv } from "@reckon/shared";
import { createTestDatabase } from "@reckon/shared/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { type AppOptions, buildApp } from "./app.ts";
import { migrateBusinessDatabase } from "./db/database.ts";

export interface BusinessMockUnderTest {
  app: FastifyInstance;
  reset(seed?: string, fixture?: unknown): Promise<void>;
  configure(config: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

// A business mock on its own freshly migrated database, with the admin interface enabled.
export async function startBusinessMock(
  options: Omit<AppOptions, "pool" | "adminEnabled"> = {},
): Promise<BusinessMockUnderTest> {
  const database = await createTestDatabase(requireEnv("BUSINESS_DATABASE_URL"));
  const pool = new pg.Pool({ connectionString: database.url });
  await migrateBusinessDatabase(pool);
  const app = buildApp({ ...options, pool, adminEnabled: true });
  return {
    app,
    async reset(seed = "seed-1", fixture = defaultFixture()) {
      expectStatus(
        await app.inject({ method: "POST", url: "/admin/reset", payload: { seed, fixture } }),
        204,
      );
    },
    async configure(config) {
      expectStatus(
        await app.inject({ method: "PATCH", url: "/admin/config", payload: config }),
        200,
      );
    },
    async close() {
      await app.close();
      await pool.end();
      await database.drop();
    },
  };
}

function expectStatus(response: LightMyRequestResponse, statusCode: number): void {
  if (response.statusCode !== statusCode) {
    throw new Error(`Expected ${statusCode}, got ${response.statusCode}: ${response.body}`);
  }
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Customer C1 owns O1 (two lines) delivered 2 days ago; C2 owns O2. 7-day window, fee 800.
export function defaultFixture() {
  return {
    policy: { returnWindowDays: 7, returnFeeCents: 800 },
    orders: [
      {
        id: "O1",
        customerId: "C1",
        status: "delivered",
        deliveredAt: daysAgo(2),
        lines: [
          { id: "L1", productName: "Kettle", quantity: 2 },
          { id: "L2", productName: "Mug", quantity: 1 },
        ],
      },
      {
        id: "O2",
        customerId: "C2",
        status: "delivered",
        deliveredAt: daysAgo(2),
        lines: [{ id: "L1", productName: "Lamp", quantity: 1 }],
      },
    ],
  };
}
