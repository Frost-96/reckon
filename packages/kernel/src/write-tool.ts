import { canonicalHash } from "@reckon/shared";
import type {
  ToolError,
  ToolOutcome,
  WriteOperationDeclaration,
  WriteToolDeclaration,
} from "./business-package.ts";
import { hasValidConfirmation } from "./confirmations.ts";
import type { ExecutionDb } from "./db/database.ts";
import type { FaultPointHook } from "./fault-points.ts";
import { checkpoint, type Lease } from "./lease.ts";
import { asStoredJson } from "./stored-json.ts";
import {
  listWriteIntents,
  prepareWriteIntent,
  replacePreparedParameters,
  transitionWriteIntent,
  type WriteIntent,
} from "./write-intents.ts";

export interface WriteContext {
  db: ExecutionDb;
  lease: Lease;
  signal: AbortSignal;
  // Business (logical) time, which write deadlines are set in (ADR 0002).
  now: () => Date;
  // Δ: how long the business service has to commit a write before it must refuse it.
  writeDeadlineMs: number;
  onFaultPoint: FaultPointHook;
}

const confirmationRequired: ToolError = {
  code: "CONFIRMATION_REQUIRED",
  message: "需要用户确认：先用 request_confirmation 请顾客确认这组参数，顾客确认后再调用",
};

// Runs a write tool's operations in order, each through its own write intent. The tool's
// parameters are already normalized (parsed by its schema).
export async function runWriteTool(
  context: WriteContext,
  tool: WriteToolDeclaration,
  parameters: unknown,
): Promise<ToolOutcome> {
  const { db, lease } = context;
  if (!(await hasValidConfirmation(db, lease.taskId, tool.name, parameters))) {
    return { ok: false, error: confirmationRequired };
  }
  const intents = new Map(
    (await listWriteIntents(db, lease.taskId)).map((intent) => [intent.operationId, intent]),
  );
  const results: Record<string, unknown> = {};
  const earlier: unknown[] = [];
  let operationId: string | undefined;
  for (const operation of tool.operations) {
    // ADR 0003: a later operation's ID derives from the one before, not from its result.
    operationId =
      operationId === undefined
        ? canonicalHash([lease.taskId, operation.name, tool.identity(parameters)])
        : canonicalHash([operationId, operation.name]);
    const outcome = await write(context, {
      tool: tool.name,
      operation,
      operationId,
      parameters: asStoredJson(
        operation.parameters(parameters, { customerId: lease.customerId, earlier }),
      ),
      intent: intents.get(operationId),
    });
    if (!outcome.ok) {
      return { ok: false, error: { ...outcome.error, operation: operation.name } };
    }
    earlier.push(outcome.result);
    results[operation.name] = outcome.result;
  }
  return { ok: true, value: results };
}

type OperationOutcome = { ok: true; result: unknown } | { ok: false; error: ToolError };

const alreadyDone: ToolError = {
  code: "WRITE_ALREADY_DONE",
  message: "这个写操作已按此前确认的参数生效，不能再用另一组参数提交",
};

// What the intent an earlier attempt left behind settles for this one; undefined when the
// operation still has to be sent.
function settledOutcome(intent: WriteIntent, parameters: unknown): OperationOutcome | undefined {
  switch (intent.state) {
    case "PREPARED":
      return undefined;
    case "CONFIRMED":
      return sameParameters(intent.parameters, parameters)
        ? { ok: true, result: intent.result }
        : { ok: false, error: alreadyDone };
    case "REJECTED":
      if (intent.error === null) {
        throw new Error(`Rejected write intent ${intent.operationId} has no rejection recorded`);
      }
      return { ok: false, error: intent.error };
    default:
      throw new Error(
        `Write intent ${intent.operationId} is ${intent.state}; resuming it is not supported yet`,
      );
  }
}

interface PendingWrite {
  tool: string;
  operation: WriteOperationDeclaration;
  operationId: string;
  parameters: unknown;
  // The intent an earlier attempt of this call left behind, if any.
  intent: WriteIntent | undefined;
}

function sameParameters(a: unknown, b: unknown): boolean {
  return canonicalHash(a) === canonicalHash(b);
}

async function write(context: WriteContext, pending: PendingWrite): Promise<OperationOutcome> {
  const { db, lease } = context;
  const { operation, operationId, parameters, intent } = pending;
  if (intent === undefined) {
    await checkpoint(db, lease, (tx) =>
      prepareWriteIntent(tx, {
        operationId,
        taskId: lease.taskId,
        tool: pending.tool,
        operation: operation.name,
        parameters,
      }),
    );
    await context.onFaultPoint({
      name: "after_prepared",
      taskId: lease.taskId,
      operation: operation.name,
      operationId,
    });
  } else {
    const settled = settledOutcome(intent, parameters);
    if (settled !== undefined) {
      return settled;
    }
    // Never sent, so nothing under this operation ID exists yet: the newly confirmed
    // parameters take the place of the old ones.
    if (!sameParameters(intent.parameters, parameters)) {
      await checkpoint(db, lease, (tx) => replacePreparedParameters(tx, operationId, parameters));
    }
  }
  const deadline = new Date(context.now().getTime() + context.writeDeadlineMs);
  await checkpoint(db, lease, (tx) =>
    transitionWriteIntent(tx, operationId, { from: "PREPARED", to: "SENT", deadline }),
  );
  const outcome = await operation.send({
    parameters,
    operationId,
    deadline,
    signal: context.signal,
  });
  switch (outcome.status) {
    case "done": {
      const result = asStoredJson(outcome.result);
      await checkpoint(db, lease, (tx) =>
        transitionWriteIntent(tx, operationId, { from: "SENT", to: "CONFIRMED", result }),
      );
      await context.onFaultPoint({
        name: "after_write_confirmed",
        taskId: lease.taskId,
        operation: operation.name,
        operationId,
      });
      return { ok: true, result };
    }
    case "rejected": {
      const { error } = outcome;
      await checkpoint(db, lease, (tx) =>
        transitionWriteIntent(tx, operationId, { from: "SENT", to: "REJECTED", error }),
      );
      return { ok: false, error };
    }
  }
}
