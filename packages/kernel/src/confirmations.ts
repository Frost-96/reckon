import { canonicalHash } from "@reckon/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { ExecutionQueries } from "./db/database.ts";
import { confirmations } from "./db/schema.ts";

// Binds a confirmation to the write tool and its normalized parameters.
function confirmationHash(tool: string, parameters: unknown): string {
  return canonicalHash({ tool, parameters });
}

export async function hasValidConfirmation(
  db: ExecutionQueries,
  taskId: string,
  tool: string,
  parameters: unknown,
): Promise<boolean> {
  const [confirmed] = await db
    .select({ seq: confirmations.seq })
    .from(confirmations)
    .where(
      and(
        eq(confirmations.taskId, taskId),
        eq(confirmations.status, "CONFIRMED"),
        eq(confirmations.parametersHash, confirmationHash(tool, parameters)),
      ),
    );
  return confirmed !== undefined;
}

// Undefined unless `seq` names a request still waiting for the customer.
export async function confirmByCustomer(
  db: ExecutionQueries,
  taskId: string,
  seq: number,
): Promise<{ tool: string; parameters: unknown } | undefined> {
  const [confirmed] = await db
    .update(confirmations)
    .set({ status: "CONFIRMED", updatedAt: sql`now()` })
    .where(
      and(
        eq(confirmations.taskId, taskId),
        eq(confirmations.seq, seq),
        eq(confirmations.status, "REQUESTED"),
      ),
    )
    .returning({ tool: confirmations.tool, parameters: confirmations.parameters });
  return confirmed;
}

// A new request invalidates the task's earlier ones, so only the latest can be confirmed.
export async function recordConfirmationRequest(
  db: ExecutionQueries,
  request: { taskId: string; seq: number; tool: string; parameters: unknown },
): Promise<void> {
  await db
    .update(confirmations)
    .set({ status: "INVALIDATED", updatedAt: sql`now()` })
    .where(and(eq(confirmations.taskId, request.taskId), ne(confirmations.status, "INVALIDATED")));
  await db.insert(confirmations).values({
    ...request,
    parametersHash: confirmationHash(request.tool, request.parameters),
    status: "REQUESTED",
  });
}
