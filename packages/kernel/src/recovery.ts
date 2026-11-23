import { eq } from "drizzle-orm";
import type { ExecutionDb } from "./db/database.ts";
import { tasks } from "./db/schema.ts";
import { checkpoint, type Lease } from "./lease.ts";
import { recordLeaseEvent } from "./lease-events.ts";

// Runs after a takeover, once the turn's progress has been rebuilt from the step log. The
// spec's order is rebuild, verify writes whose outcome is unknown, recheck volatile reads;
// those two belong between the rebuilt and resumed events. Until resumed is checkpointed the
// task still needs recovery, so a holder dropped halfway leaves it to the next one.
export async function recover(db: ExecutionDb, lease: Lease): Promise<void> {
  const event = { taskId: lease.taskId, version: lease.version, owner: lease.owner };
  await checkpoint(db, lease, (tx) => recordLeaseEvent(tx, { ...event, kind: "rebuilt" }));
  await checkpoint(db, lease, async (tx) => {
    await recordLeaseEvent(tx, { ...event, kind: "resumed" });
    await tx.update(tasks).set({ needsRecovery: false }).where(eq(tasks.id, lease.taskId));
  });
}
