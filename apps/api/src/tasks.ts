import {
  ConfirmationNotPendingError,
  closeTask,
  createTask,
  type ExecutionDb,
  getTask,
  listUserVisibleMessages,
  postCustomerMessage,
  RunNotFoundError,
  type Task,
  TaskNotFoundError,
  TaskNotWaitingForCustomerError,
} from "@reckon/kernel";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// An error answered with `{ error: { code, message } }` and the given status code.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "INVALID_REQUEST", result.error.message);
  }
  return result.data;
}

function taskNotFound(): never {
  throw new ApiError(404, "TASK_NOT_FOUND", "No such task");
}

const taskParams = z.object({ taskId: z.string() });
const createTaskBody = z
  .object({
    customerId: z.string().min(1),
    // The experiment run the task belongs to; the evaluator's simulated user sets it.
    runId: z.uuid().optional(),
  })
  .strict();
const customerMessageBody = z
  .object({
    content: z.string().min(1),
    // The seq of the agent message whose confirmation request this message confirms.
    confirms: z.int().positive().optional(),
  })
  .strict();

// Task ids are UUIDs; anything else cannot name a task.
function taskIdOf(params: unknown): string {
  const { taskId } = parseRequest(taskParams, params);
  return z.uuid().safeParse(taskId).success ? taskId : taskNotFound();
}

function taskView(task: Task) {
  return {
    id: task.id,
    customerId: task.customerId,
    runId: task.runId,
    state: task.state,
    turn: task.turn,
  };
}

// Maps the kernel's refusals of a customer action on a task to API errors.
function refusal(error: unknown): never {
  if (error instanceof TaskNotFoundError) {
    taskNotFound();
  }
  if (error instanceof TaskNotWaitingForCustomerError) {
    throw new ApiError(409, "TASK_NOT_WAITING_FOR_CUSTOMER", error.message);
  }
  if (error instanceof ConfirmationNotPendingError) {
    throw new ApiError(409, "CONFIRMATION_NOT_PENDING", error.message);
  }
  throw error;
}

export function registerTaskRoutes(app: FastifyInstance, db: ExecutionDb): void {
  app.post("/tasks", async (request, reply) => {
    const { customerId, runId } = parseRequest(createTaskBody, request.body);
    try {
      const task = await createTask(db, { customerId, ...(runId === undefined ? {} : { runId }) });
      return reply.code(201).send(taskView(task));
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        throw new ApiError(422, "RUN_NOT_FOUND", error.message);
      }
      throw error;
    }
  });

  app.get("/tasks/:taskId", async (request) => {
    const task = await getTask(db, taskIdOf(request.params));
    return task === undefined ? taskNotFound() : taskView(task);
  });

  app.post("/tasks/:taskId/messages", async (request, reply) => {
    const { content, confirms } = parseRequest(customerMessageBody, request.body);
    const taskId = taskIdOf(request.params);
    try {
      const options = confirms === undefined ? {} : { confirms };
      return reply.code(202).send(await postCustomerMessage(db, taskId, content, options));
    } catch (error) {
      refusal(error);
    }
  });

  // The customer ends the session.
  app.post("/tasks/:taskId/close", async (request) => {
    const taskId = taskIdOf(request.params);
    try {
      return taskView(await closeTask(db, taskId));
    } catch (error) {
      refusal(error);
    }
  });

  app.get("/tasks/:taskId/messages", async (request) => {
    const taskId = taskIdOf(request.params);
    if ((await getTask(db, taskId)) === undefined) {
      taskNotFound();
    }
    const messages = await listUserVisibleMessages(db, taskId);
    return messages.map(({ turn, seq, role, content, payload, createdAt }) => ({
      turn,
      seq,
      role,
      content,
      payload,
      createdAt: createdAt.toISOString(),
    }));
  });
}
