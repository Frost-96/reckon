import { canonicalHash, canonicalJson } from "@reckon/shared";
import { z } from "zod";
import type { ToolDeclaration, ToolError, ToolOutcome } from "./business-package.ts";
import type { ExecutionDb } from "./db/database.ts";
import { checkpoint, type Lease, releaseToCustomer } from "./lease.ts";
import type { ModelClient, ModelMessage, ModelRequest, ModelToolCall } from "./model.ts";
import {
  appendStep,
  type ModelStep,
  type NewStep,
  readStepLog,
  type ToolStep,
} from "./step-log.ts";
import {
  appendUserVisibleMessage,
  listUserVisibleMessages,
  type UserVisibleMessage,
} from "./tasks.ts";
import type { ToolRegistry } from "./tool-registry.ts";

export interface TurnContext {
  db: ExecutionDb;
  lease: Lease;
  systemPrompt: string;
  tools: ToolRegistry;
  model: ModelClient;
  signal: AbortSignal;
}

interface TaskHistory {
  customerMessages: UserVisibleMessage[];
  steps: NewStep[];
}

// Runs the lease holder's current turn until the agent replies to the customer. Progress comes
// from the step log, so a turn resumes after the last logged step.
export async function runTurn(context: TurnContext): Promise<void> {
  const { db, lease, model, signal } = context;
  const history = await loadHistory(db, lease.taskId);
  for (;;) {
    signal.throwIfAborted();
    const pendingCall = nextPendingToolCall(history.steps, lease.turn);
    if (pendingCall !== undefined) {
      const step = await runToolCall(context, pendingCall, history.steps.length + 1);
      await checkpoint(db, lease, (tx) => appendStep(tx, step));
      history.steps.push(step);
      continue;
    }

    const request = buildModelRequest(context, history);
    const response = await model.complete(request, { signal });
    signal.throwIfAborted();
    const step: ModelStep = {
      taskId: lease.taskId,
      seq: history.steps.length + 1,
      turn: lease.turn,
      kind: "model",
      status: "ok",
      attempt: lease.version,
      inputHash: canonicalHash(request),
      output: response,
    };
    if (response.toolCalls.length > 0) {
      await checkpoint(db, lease, (tx) => appendStep(tx, step));
      history.steps.push(step);
      continue;
    }
    await checkpoint(db, lease, async (tx) => {
      await appendStep(tx, step);
      await appendUserVisibleMessage(tx, {
        taskId: lease.taskId,
        turn: lease.turn,
        seq: 1,
        role: "agent",
        content: response.content ?? "",
      });
      await releaseToCustomer(tx, lease);
    });
    return;
  }
}

async function loadHistory(db: ExecutionDb, taskId: string): Promise<TaskHistory> {
  const [messages, steps] = await Promise.all([
    listUserVisibleMessages(db, taskId),
    readStepLog(db, taskId),
  ]);
  return { customerMessages: messages.filter((m) => m.role === "customer"), steps };
}

// The first call of the turn's latest model step that has no tool step yet. Tool steps follow
// their model step in call order, so the count of tool steps after it is the next call's index.
function nextPendingToolCall(steps: NewStep[], turn: number): ModelToolCall | undefined {
  const turnSteps = steps.filter((step) => step.turn === turn);
  const modelIndex = turnSteps.findLastIndex((step) => step.kind === "model");
  const modelStep = turnSteps[modelIndex];
  if (modelStep?.kind !== "model") {
    return undefined;
  }
  return modelStep.output.toolCalls[turnSteps.length - 1 - modelIndex];
}

async function runToolCall(
  context: TurnContext,
  call: ModelToolCall,
  seq: number,
): Promise<ToolStep> {
  const { lease } = context;
  const parsed = parseToolCall(context.tools, call);
  const parameters = parsed.ok ? parsed.parameters : call.arguments;
  const outcome: ToolOutcome = parsed.ok
    ? await parsed.tool.run(parsed.parameters, {
        taskId: lease.taskId,
        customerId: lease.customerId,
        signal: context.signal,
      })
    : parsed;
  return {
    taskId: lease.taskId,
    seq,
    turn: lease.turn,
    kind: "tool",
    status: outcome.ok ? "ok" : "error",
    attempt: lease.version,
    // Tool + parameters, the key under which identical reads are deduplicated.
    inputHash: canonicalHash({ name: call.name, parameters }),
    input: { toolCallId: call.id, name: call.name, arguments: call.arguments },
    // In its stored JSON form, so the live context equals the one rebuilt from the log.
    output: asStoredJson(outcome.ok ? outcome.value : { error: outcome.error }),
  };
}

function asStoredJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? "null");
}

type ParsedToolCall =
  | { ok: true; tool: ToolDeclaration; parameters: unknown }
  | { ok: false; error: ToolError };

// A call the kernel cannot run goes back to the model as a structured error, not to the tool.
function parseToolCall(tools: ToolRegistry, call: ModelToolCall): ParsedToolCall {
  const tool = tools.find(call.name);
  if (tool === undefined) {
    return { ok: false, error: { code: "UNKNOWN_TOOL", message: `No tool named ${call.name}` } };
  }
  let json: unknown;
  try {
    json = JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "Arguments are not JSON" } };
  }
  const result = tool.parameters.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENTS", message: z.prettifyError(result.error) },
    };
  }
  return { ok: true, tool, parameters: result.data };
}

function buildModelRequest(context: TurnContext, history: TaskHistory): ModelRequest {
  const messages: ModelMessage[] = [{ role: "system", content: context.systemPrompt }];
  for (const customerMessage of history.customerMessages) {
    messages.push({ role: "user", content: customerMessage.content });
    for (const step of history.steps) {
      if (step.turn !== customerMessage.turn) {
        continue;
      }
      messages.push(
        step.kind === "model"
          ? { role: "assistant", content: step.output.content, toolCalls: step.output.toolCalls }
          : {
              role: "tool",
              toolCallId: step.input.toolCallId,
              content: canonicalJson(step.output),
            },
      );
    }
  }
  return { messages, tools: context.tools.definitions };
}
