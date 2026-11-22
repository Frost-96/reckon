import { canonicalHash, canonicalJson } from "@reckon/shared";
import { z } from "zod";
import type { ToolError, ToolOutcome } from "./business-package.ts";
import type { ExecutionDb } from "./db/database.ts";
import { notExecuted, type Question } from "./interaction.ts";
import { checkpoint, type Lease, releaseToCustomer } from "./lease.ts";
import type { ModelClient, ModelMessage, ModelRequest, ModelToolCall } from "./model.ts";
import { recover } from "./recovery.ts";
import {
  appendStep,
  type ModelStep,
  type NewStep,
  readStepLog,
  type ToolStep,
} from "./step-log.ts";
import { asStoredJson } from "./stored-json.ts";
import {
  appendUserVisibleMessage,
  listUserVisibleMessages,
  type UserVisibleMessage,
} from "./tasks.ts";
import type { RegisteredTool, ToolRegistry } from "./tool-registry.ts";
import { runWriteTool, type WriteContext } from "./write-tool.ts";

export interface TurnContext extends WriteContext {
  systemPrompt: string;
  tools: ToolRegistry;
  model: ModelClient;
}

interface TaskHistory {
  customerMessages: UserVisibleMessage[];
  steps: NewStep[];
}

// Runs the lease holder's current turn until the agent replies to the customer or asks them
// something. Progress comes from the step log, so a turn resumes after the last logged step.
export async function runTurn(context: TurnContext): Promise<void> {
  const { db, lease, model, signal } = context;
  const history = await loadHistory(db, lease.taskId);
  if (lease.needsRecovery) {
    await recover(db, lease);
  }
  for (;;) {
    signal.throwIfAborted();
    const [pendingCall, ...laterCalls] = nextPendingToolCalls(history.steps, lease.turn);
    if (pendingCall !== undefined) {
      const { step, question } = await runToolCall(context, pendingCall, history.steps.length + 1);
      if (question === undefined) {
        await checkpoint(db, lease, (tx) => appendStep(tx, step));
        history.steps.push(step);
        continue;
      }
      // The call, the results of the calls it cut off and the question land together.
      const skipped = laterCalls.map((call, k) => notExecutedStep(lease, call, step.seq + 1 + k));
      await checkpoint(db, lease, async (tx) => {
        for (const logged of [step, ...skipped]) {
          await appendStep(tx, logged);
        }
        await question.record?.(tx, { taskId: lease.taskId, seq: step.seq });
        await appendUserVisibleMessage(tx, {
          taskId: lease.taskId,
          turn: lease.turn,
          seq: step.seq,
          role: "agent",
          content: question.content,
          payload: question.payload,
        });
        await releaseToCustomer(tx, lease);
      });
      return;
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
        seq: step.seq,
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

// The calls of the turn's latest model step that have no tool step yet. Tool steps follow
// their model step in call order, so the count of tool steps after it is the next call's index.
function nextPendingToolCalls(steps: NewStep[], turn: number): ModelToolCall[] {
  const turnSteps = steps.filter((step) => step.turn === turn);
  const modelIndex = turnSteps.findLastIndex((step) => step.kind === "model");
  const modelStep = turnSteps[modelIndex];
  if (modelStep?.kind !== "model") {
    return [];
  }
  return modelStep.output.toolCalls.slice(turnSteps.length - 1 - modelIndex);
}

interface ExecutedToolCall {
  step: ToolStep;
  // Set when the call ended the turn to wait for the customer.
  question?: Question;
}

async function runToolCall(
  context: TurnContext,
  call: ModelToolCall,
  seq: number,
): Promise<ExecutedToolCall> {
  const { lease } = context;
  const parsed = parseToolCall(context.tools, call);
  if (!parsed.ok) {
    return { step: toolStep(lease, call, seq, call.arguments, parsed) };
  }
  const { tool, parameters } = parsed;
  if (tool.kind === "interaction") {
    const question = tool.ask(parameters);
    const outcome: ToolOutcome = { ok: true, value: question.result };
    return { step: toolStep(lease, call, seq, parameters, outcome), question };
  }
  if (tool.kind === "write") {
    const outcome = await runWriteTool(context, tool, parameters);
    return { step: toolStep(lease, call, seq, parameters, outcome) };
  }
  const outcome = await tool.run(parameters, {
    taskId: lease.taskId,
    customerId: lease.customerId,
    signal: context.signal,
  });
  await context.onFaultPoint({
    name: "after_read_before_checkpoint",
    taskId: lease.taskId,
    tool: tool.name,
  });
  return { step: toolStep(lease, call, seq, parameters, outcome) };
}

function toolStep(
  lease: Lease,
  call: ModelToolCall,
  seq: number,
  parameters: unknown,
  outcome: ToolOutcome,
): ToolStep {
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

function notExecutedStep(lease: Lease, call: ModelToolCall, seq: number): ToolStep {
  return toolStep(lease, call, seq, call.arguments, { ok: false, error: notExecuted });
}

type ParsedToolCall =
  | { ok: true; tool: RegisteredTool; parameters: unknown }
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
    messages.push({ role: "user", content: customerContent(customerMessage) });
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

// A confirmation reaches the model together with what the customer confirmed.
function customerContent(message: UserVisibleMessage): string {
  const { payload } = message;
  if (payload?.kind !== "confirmation") {
    return message.content;
  }
  const { tool, parameters } = payload;
  return canonicalJson({ message: message.content, confirmed: { tool, parameters } });
}
