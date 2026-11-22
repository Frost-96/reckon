import type { BusinessQueries } from "./db/database.ts";
import { type idempotencyModes, mockConfig } from "./db/schema.ts";

export interface MockConfig {
  scenarioSeed: string;
  idempotencyMode: (typeof idempotencyModes)[number];
  // ADR 0006: on by default, a write carrying a fee other than the current one is refused.
  checkFee: boolean;
  // Non-atomic processing time during which the idempotency key is in flight.
  processingDelayMs: number;
}

export const defaultMockConfig: MockConfig = {
  scenarioSeed: "unseeded",
  idempotencyMode: "key",
  checkFee: true,
  processingDelayMs: 0,
};

export async function readMockConfig(db: BusinessQueries): Promise<MockConfig> {
  const [row] = await db.select().from(mockConfig);
  if (row === undefined) {
    return defaultMockConfig;
  }
  const { id: _id, ...config } = row;
  return config;
}

export async function writeMockConfig(db: BusinessQueries, config: MockConfig): Promise<void> {
  await db
    .insert(mockConfig)
    .values({ id: 1, ...config })
    .onConflictDoUpdate({ target: mockConfig.id, set: config });
}
