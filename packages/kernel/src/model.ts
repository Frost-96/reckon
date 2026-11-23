// The kernel's own model interface: one `complete` call is one model request. Implementations
// (scripted fake, recording/replay, a real vendor) are swapped without touching the agent loop.

export interface ModelToolCall {
  id: string;
  name: string;
  // Raw JSON text as the model produced it; the kernel parses and validates it.
  arguments: string;
}

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelToolDefinition {
  name: string;
  description: string;
  // JSON Schema of the arguments object.
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ModelToolCall[];
  usage?: ModelUsage;
}

export interface ModelCallOptions {
  signal?: AbortSignal;
  // Text fragments as they stream in; only a draft until the response is complete. Awaited
  // before the next fragment, so fragments are taken in order and one can hold the call there.
  onTextDelta?: (delta: string) => void | Promise<void>;
}

export interface ModelClient {
  complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse>;
}
