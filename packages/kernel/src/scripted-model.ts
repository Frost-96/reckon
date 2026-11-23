import type {
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./model.ts";

export interface ScriptedToolCall {
  id?: string | undefined;
  name: string;
  // An object is sent as JSON; a string is sent verbatim (e.g. to script malformed JSON).
  arguments: unknown;
}

export interface ScriptedResponse {
  content?: string | undefined;
  toolCalls?: ScriptedToolCall[] | undefined;
}

// A fixed response, or a function of the request (it may wait, e.g. to hold a step open).
export type ScriptedStep =
  | ScriptedResponse
  | ((
      request: ModelRequest,
      options: ModelCallOptions,
    ) => Promise<ScriptedResponse> | ScriptedResponse);

export interface ScriptedModel extends ModelClient {
  // Every request received, in order.
  readonly requests: readonly ModelRequest[];
}

// Answers the n-th request with the n-th scripted step.
export function createScriptedModel(script: readonly ScriptedStep[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(request, options = {}) {
      const index = requests.length;
      requests.push(structuredClone(request));
      const step = script[index];
      if (step === undefined) {
        throw new Error(`Scripted model has no response for request #${index + 1}`);
      }
      const scripted = typeof step === "function" ? await step(request, options) : step;
      return stream(scripted, `call_${index + 1}`, options);
    },
  };
}

// Answers the k-th model call of the n-th turn with turns[n-1][k-1]. The position is read off
// the request (its customer messages, and the assistant messages after the last one), so any
// executor, also one taking over after a crash, gets the same answer for the same call.
export function createTurnScriptedModel(
  turns: readonly (readonly ScriptedResponse[])[],
): ModelClient {
  return {
    async complete(request, options = {}) {
      const turn = request.messages.filter((message) => message.role === "user").length;
      const lastUser = request.messages.findLastIndex((message) => message.role === "user");
      const call =
        request.messages.slice(lastUser + 1).filter((message) => message.role === "assistant")
          .length + 1;
      const scripted = turns[turn - 1]?.[call - 1];
      if (scripted === undefined) {
        throw new Error(`Scripted model has no response for call ${call} of turn ${turn}`);
      }
      return stream(scripted, `call_${turn}_${call}`, options);
    },
  };
}

async function stream(
  scripted: ScriptedResponse,
  callIdPrefix: string,
  options: ModelCallOptions,
): Promise<ModelResponse> {
  for (const fragment of fragments(scripted.content ?? "")) {
    options.signal?.throwIfAborted();
    await options.onTextDelta?.(fragment);
  }
  options.signal?.throwIfAborted();
  return toResponse(scripted, callIdPrefix);
}

const fragmentLength = 4;

// Splits by code points so no fragment ends inside a surrogate pair.
function fragments(text: string): string[] {
  const codePoints = Array.from(text);
  const result: string[] = [];
  for (let start = 0; start < codePoints.length; start += fragmentLength) {
    result.push(codePoints.slice(start, start + fragmentLength).join(""));
  }
  return result;
}

function toResponse(scripted: ScriptedResponse, callIdPrefix: string): ModelResponse {
  const toolCalls = (scripted.toolCalls ?? []).map(
    (call, k): ModelToolCall => ({
      id: call.id ?? `${callIdPrefix}_${k + 1}`,
      name: call.name,
      arguments:
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
    }),
  );
  return { content: scripted.content ?? null, toolCalls };
}
