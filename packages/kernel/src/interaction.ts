import { z } from "zod";
import type { ToolError, WriteToolDeclaration } from "./business-package.ts";
import { recordConfirmationRequest } from "./confirmations.ts";
import type { ExecutionTx } from "./db/database.ts";
import type { MessagePayload } from "./tasks.ts";

// Kernel built-ins that end the turn: the agent waits for the customer instead of going on.

export interface InteractionTool<Parameters extends z.ZodType = z.ZodType> {
  kind: "interaction";
  name: string;
  description: string;
  parameters: Parameters;
  // What the customer is shown, and what the model is told the call did.
  ask(parameters: z.output<Parameters>): Question;
}

export interface Question {
  content: string;
  payload: MessagePayload;
  result: unknown;
  // Kernel state the question opens, written with the question itself.
  record?(tx: ExecutionTx, at: { taskId: string; seq: number }): Promise<void>;
}

function defineInteractionTool<Parameters extends z.ZodType>(
  tool: InteractionTool<Parameters>,
): InteractionTool {
  return tool;
}

export const askUser = defineInteractionTool({
  kind: "interaction",
  name: "ask_user",
  description: "向顾客追问缺失的信息，然后结束本轮、等待顾客回答。",
  parameters: z.object({
    question: z.string().min(1).describe("向顾客提出的问题"),
    slot: z.string().min(1).describe("这个问题要补全的信息，例如 orderId"),
    options: z.array(z.string().min(1)).min(1).optional().describe("可供顾客选择的选项"),
  }),
  ask({ question, slot, options }) {
    return {
      content: question,
      payload: { kind: "question", slot, ...(options === undefined ? {} : { options }) },
      result: { status: "waiting_for_customer" },
    };
  },
});

// Offered once the business package has write tools: the customer confirms the normalized
// parameters of one write tool, and only then may that tool write with them.
export function requestConfirmation(writeTools: readonly WriteToolDeclaration[]): InteractionTool {
  const [first, ...rest] = writeTools.map((tool) =>
    z.object({
      tool: z.literal(tool.name).describe("要确认的写工具"),
      parameters: tool.parameters.describe("该写工具的完整参数，与随后调用它时一致"),
      message: z.string().min(1).describe("给顾客看的确认说明"),
    }),
  );
  if (first === undefined) {
    throw new Error("request_confirmation needs at least one write tool");
  }
  return defineInteractionTool({
    kind: "interaction",
    name: "request_confirmation",
    description:
      "调用写工具之前，请顾客确认这组参数，然后结束本轮、等待顾客确认。参数一变，原确认即失效。",
    parameters: rest.length === 0 ? first : z.discriminatedUnion("tool", [first, ...rest]),
    ask({ tool, parameters, message }) {
      return {
        content: message,
        payload: { kind: "confirmation_request", tool, parameters },
        result: { status: "waiting_for_customer" },
        record: (tx, at) => recordConfirmationRequest(tx, { ...at, tool, parameters }),
      };
    },
  });
}

// The synthetic result of a call the model made after the turn had already ended.
export const notExecuted: ToolError = {
  code: "NOT_EXECUTED",
  message: "未执行：本轮已转为等待用户",
};
