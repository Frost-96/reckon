import type { ExecutionQueries } from "./db/database.ts";
import { executorStarts } from "./db/schema.ts";

// Recorded by an executor process as it starts, stamped by the database clock, so the time a
// dropped instance took to come back can be told apart from the recovery a peer carried out.
export async function recordExecutorStart(
  db: ExecutionQueries,
  start: { owner: string; host: string },
): Promise<void> {
  await db.insert(executorStarts).values(start);
}
