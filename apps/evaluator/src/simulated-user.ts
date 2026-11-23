import { setTimeout as sleep } from "node:timers/promises";
import type { TaskState } from "@reckon/kernel";
import { canonicalJson } from "@reckon/shared";
import type { MessageView, TaskApi } from "./http.ts";
import type { SimulatedUser } from "./scenario.ts";

export type ConversationEnd =
  // The user said everything the script has and ended the session.
  | "script_completed"
  // The agent asked for a slot the script has no answer for; the user ended the session.
  | "question_unanswered"
  // The agent asked to confirm something the user does not agree to; the user ended the session.
  | "confirmation_refused"
  // The task stopped waiting for the user by itself, e.g. it was handed off.
  | "task_ended"
  // The agent did not finish a turn in time; the task is left as it is.
  | "turn_timeout";

export interface Conversation {
  taskId: string;
  ended: ConversationEnd;
  taskState: TaskState;
  messages: MessageView[];
}

export interface ConversationOptions {
  runId: string;
  pollIntervalMs: number;
  turnTimeoutMs: number;
  // Runs once the task exists, before the user says anything.
  onTaskCreated?: (taskId: string) => Promise<void>;
}

type Reply = { content: string; confirms?: number } | { end: ConversationEnd };

// Holds the conversation through the task API only, as a customer would.
export async function converse(
  api: TaskApi,
  user: SimulatedUser,
  options: ConversationOptions,
): Promise<Conversation> {
  const task = await api.createTask({ customerId: user.customerId, runId: options.runId });
  await options.onTaskCreated?.(task.id);
  const [opening, ...followUps] = user.messages;
  let reply: Reply = { content: opening ?? "" };
  while (!("end" in reply)) {
    const { turn } = await api.postMessage(task.id, reply.content, reply.confirms);
    const state = await waitForTurnEnd(api, task.id, options);
    if (state === undefined) {
      return ended(api, task.id, "turn_timeout");
    }
    if (state !== "WAITING_USER") {
      return ended(api, task.id, "task_ended");
    }
    const agentMessage = (await api.listMessages(task.id))
      .filter((message) => message.turn === turn && message.role === "agent")
      .at(-1);
    if (agentMessage === undefined) {
      throw new Error(`Turn ${turn} of task ${task.id} ended without a message to the customer`);
    }
    reply = respond(user, agentMessage, followUps);
  }
  await api.closeTask(task.id);
  return ended(api, task.id, reply.end);
}

function respond(user: SimulatedUser, message: MessageView, followUps: string[]): Reply {
  const { payload } = message;
  if (payload?.kind === "question") {
    const answer = user.answers[payload.slot];
    return answer === undefined ? { end: "question_unanswered" } : { content: answer };
  }
  if (payload?.kind === "confirmation_request") {
    const asked = canonicalJson({ tool: payload.tool, parameters: payload.parameters });
    const agreed = user.confirmations.some(
      (expected) =>
        canonicalJson({ tool: expected.tool, parameters: expected.parameters }) === asked,
    );
    return agreed
      ? { content: user.confirmationReply, confirms: message.seq }
      : { end: "confirmation_refused" };
  }
  const next = followUps.shift();
  return next === undefined ? { end: "script_completed" } : { content: next };
}

// The task's state once the agent stops working on the turn; undefined on timeout.
async function waitForTurnEnd(
  api: TaskApi,
  taskId: string,
  options: ConversationOptions,
): Promise<TaskState | undefined> {
  const deadline = Date.now() + options.turnTimeoutMs;
  for (;;) {
    const { state } = await api.getTask(taskId);
    if (state !== "READY" && state !== "RUNNING") {
      return state;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(options.pollIntervalMs);
  }
}

async function ended(api: TaskApi, taskId: string, end: ConversationEnd): Promise<Conversation> {
  const [task, messages] = await Promise.all([api.getTask(taskId), api.listMessages(taskId)]);
  return { taskId, ended: end, taskState: task.state, messages };
}
