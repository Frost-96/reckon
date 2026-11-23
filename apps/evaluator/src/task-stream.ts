import type { StreamEvent } from "./customer-view.ts";

export interface TaskStream {
  // Every draft and message event received so far, in order; other kinds are skipped.
  readonly events: readonly StreamEvent[];
  // Throws if reading the stream failed before.
  close(): Promise<void>;
}

// Follows GET /tasks/:taskId/events. Resolves once the task API has answered, so every event
// committed after that reaches `events`.
export async function followTask(taskApiUrl: string, taskId: string): Promise<TaskStream> {
  const controller = new AbortController();
  const response = await fetch(new URL(`/tasks/${taskId}/events`, taskApiUrl), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`GET /tasks/${taskId}/events answered ${response.status}`);
  }
  const events: StreamEvent[] = [];
  let failure: { error: unknown } | undefined;
  const reading = readEvents(response.body, (event) => events.push(event)).catch((error) => {
    if (!controller.signal.aborted) {
      failure = { error };
    }
  });
  return {
    events,
    async close() {
      controller.abort();
      await reading;
      if (failure !== undefined) {
        throw failure.error;
      }
    },
  };
}

// The task API writes each event as `event: <name>` and one `data: <json>` line.
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const fields = new Map<string, string>();
      for (const line of buffer.slice(0, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          fields.set(line.slice(0, colon), line.slice(colon + 1).trimStart());
        }
      }
      buffer = buffer.slice(end + 2);
      const event = fields.get("event");
      const data = fields.get("data");
      if ((event === "draft" || event === "message") && data !== undefined) {
        onEvent({ event, data: JSON.parse(data) } as StreamEvent);
      }
    }
  }
}
