import { setTimeout as sleep } from "node:timers/promises";
import { canonicalHash, canonicalJson } from "@reckon/shared";
import { and, eq, sql } from "drizzle-orm";
import { type MockConfig, readMockConfig } from "./config.ts";
import type { BusinessDb, BusinessTx } from "./db/database.ts";
import { idempotencyKeys } from "./db/schema.ts";
import { Rejection } from "./errors.ts";

export interface WriteRequest {
  endpoint: string;
  key: string | undefined;
  // Path parameters and body of the request, minus fields a retry may legitimately change.
  parameters: unknown;
}

export interface WriteResult {
  statusCode: number;
  body: unknown;
}

export interface WriteOutcome extends WriteResult {
  replayed: boolean;
}

// Idempotency key mode. The key is registered in the same transaction as the write, so only a
// committed write takes it: a request refused by a business rule leaves the key free.
export async function runIdempotentWrite(
  db: BusinessDb,
  request: WriteRequest,
  perform: (tx: BusinessTx, config: MockConfig) => Promise<WriteResult>,
): Promise<WriteOutcome> {
  const { endpoint, key } = request;
  const requestHash = canonicalHash(request.parameters);
  return db.transaction(async (tx) => {
    const config = await readMockConfig(tx);
    if (key === undefined || key === "") {
      throw new Rejection(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header");
    }
    // Held until commit or rollback, so it marks the key as in flight for exactly that long.
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${canonicalJson([endpoint, key])}, 0)) as locked`,
    );
    if (lock.rows[0]?.locked !== true) {
      throw new Rejection(
        409,
        "IDEMPOTENCY_CONCURRENT_REQUEST",
        "A request with this idempotency key is still being processed",
      );
    }
    const [registered] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.endpoint, endpoint), eq(idempotencyKeys.key, key)));
    if (registered !== undefined) {
      if (registered.requestHash !== requestHash) {
        throw new Rejection(
          422,
          "IDEMPOTENCY_KEY_PARAMETER_MISMATCH",
          "This idempotency key was used with different parameters",
        );
      }
      return { statusCode: registered.statusCode, body: registered.response, replayed: true };
    }
    if (config.processingDelayMs > 0) {
      await sleep(config.processingDelayMs);
    }
    const result = await perform(tx, config);
    await tx.insert(idempotencyKeys).values({
      endpoint,
      key,
      requestHash,
      statusCode: result.statusCode,
      response: result.body,
    });
    return { ...result, replayed: false };
  });
}
