import type { MessagePayload, TaskState } from "@reckon/kernel";

export interface TaskView {
  id: string;
  customerId: string;
  runId: string | null;
  state: TaskState;
  turn: number;
}

export interface MessageView {
  turn: number;
  seq: number;
  role: "customer" | "agent";
  content: string;
  payload: MessagePayload | null;
  createdAt: string;
}

async function call(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  expectedStatus: number,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  }
  return text === "" ? undefined : JSON.parse(text);
}

// The task API as a customer uses it.
export interface TaskApi {
  createTask(input: { customerId: string; runId: string }): Promise<TaskView>;
  getTask(taskId: string): Promise<TaskView>;
  postMessage(taskId: string, content: string, confirms?: number): Promise<{ turn: number }>;
  listMessages(taskId: string): Promise<MessageView[]>;
  closeTask(taskId: string): Promise<TaskView>;
}

export function taskApi(baseUrl: string): TaskApi {
  return {
    createTask: async (input) => (await call(baseUrl, "POST", "/tasks", 201, input)) as TaskView,
    getTask: async (taskId) => (await call(baseUrl, "GET", `/tasks/${taskId}`, 200)) as TaskView,
    postMessage: async (taskId, content, confirms) =>
      (await call(baseUrl, "POST", `/tasks/${taskId}/messages`, 202, {
        content,
        ...(confirms === undefined ? {} : { confirms }),
      })) as { turn: number },
    listMessages: async (taskId) =>
      (await call(baseUrl, "GET", `/tasks/${taskId}/messages`, 200)) as MessageView[],
    closeTask: async (taskId) =>
      (await call(baseUrl, "POST", `/tasks/${taskId}/close`, 200)) as TaskView,
  };
}

// Business data is reset through the mock's admin API, never written directly.
export async function resetBusinessMock(
  baseUrl: string,
  input: { seed: string; fixture: unknown },
): Promise<void> {
  await call(baseUrl, "POST", "/admin/reset", 204, input);
}
