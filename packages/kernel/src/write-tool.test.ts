import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import {
  type BusinessPackage,
  ConfirmationNotPendingError,
  createExecutor,
  createScriptedModel,
  createTask,
  defineWriteTool,
  type ExecutionDb,
  type ExecutorOptions,
  getTask,
  listUserVisibleMessages,
  listWriteIntents,
  type ModelRequest,
  postCustomerMessage,
  readStepLog,
  type ScriptedStep,
  type ToolError,
  type WriteIntent,
} from "./index.ts";
import { type ExecutionTestDatabase, startExecutionTestDatabase } from "./testing.ts";

let database: ExecutionTestDatabase;
let db: ExecutionDb;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.close();
});

interface SentWrite {
  operation: string;
  operationId: string;
  parameters: unknown;
  deadline: Date;
}

interface BookingServiceOptions {
  // Business rejections by operation name.
  rejections?: Record<string, ToolError>;
  // Runs as a request arrives, before the service answers it.
  onSend?: (operation: string) => Promise<void>;
}

// A domain-neutral write service the test controls: holding a room, then issuing a voucher for
// the hold. It records every request it receives.
function bookingService({ rejections = {}, onSend }: BookingServiceOptions = {}) {
  const sent: SentWrite[] = [];
  const businessPackage: BusinessPackage = {
    systemPrompt: "You book rooms.",
    tools: [
      defineWriteTool({
        kind: "write",
        name: "book_room",
        description: "Hold a room and issue its voucher",
        parameters: z.object({
          roomId: z.string(),
          nights: z.int().positive(),
          guest: z.string().trim().min(1),
        }),
        identity: ({ roomId }) => ({ roomId }),
        operations: [
          {
            name: "hold_room",
            parameters: (booking, { customerId }) => ({ customerId, ...booking }),
            async send({ parameters, operationId, deadline }) {
              sent.push({ operation: "hold_room", operationId, parameters, deadline });
              await onSend?.("hold_room");
              const rejection = rejections.hold_room;
              return rejection === undefined
                ? { status: "done", result: { holdId: `H-${operationId.slice(0, 8)}` } }
                : { status: "rejected", error: rejection };
            },
          },
          {
            name: "issue_voucher",
            parameters: (_booking, { earlier }) => ({
              holdId: z.object({ holdId: z.string() }).parse(earlier[0]).holdId,
            }),
            async send({ parameters, operationId, deadline }) {
              sent.push({ operation: "issue_voucher", operationId, parameters, deadline });
              await onSend?.("issue_voucher");
              const rejection = rejections.issue_voucher;
              return rejection === undefined
                ? { status: "done", result: { voucherId: `V-${operationId.slice(0, 8)}` } }
                : { status: "rejected", error: rejection };
            },
          },
        ],
      }),
    ],
  };
  return { sent, businessPackage };
}

async function taskWithMessage(content: string): Promise<string> {
  const task = await createTask(db, { customerId: "C1" });
  await postCustomerMessage(db, task.id, content);
  return task.id;
}

async function runTurnWith(
  businessPackage: BusinessPackage,
  script: ScriptedStep[],
  options: Partial<ExecutorOptions> = {},
) {
  const model = createScriptedModel(script);
  const executor = createExecutor({ db, owner: "executor-1", businessPackage, model, ...options });
  const outcome = await executor.runOnce();
  return { model, outcome };
}

function lastToolResult(request: ModelRequest | undefined): unknown {
  const message = request?.messages.at(-1);
  if (message?.role !== "tool") {
    throw new Error("The request does not end with a tool result");
  }
  return JSON.parse(message.content);
}

const booking = { roomId: "R7", nights: 2, guest: "Ada" };

function requestConfirmation(parameters: unknown, message = "Book R7 for 2 nights?") {
  return { name: "request_confirmation", arguments: { tool: "book_room", parameters, message } };
}

// The seq of the latest confirmation request shown to the customer.
async function requestedConfirmation(taskId: string): Promise<number> {
  const messages = await listUserVisibleMessages(db, taskId);
  const request = messages.findLast((m) => m.payload?.kind === "confirmation_request");
  if (request === undefined) {
    throw new Error("No confirmation was requested");
  }
  return request.seq;
}

// Turn 1 asks to confirm `parameters`; the customer confirms them, which starts turn 2.
async function confirmedTask(businessPackage: BusinessPackage, parameters: unknown) {
  const taskId = await taskWithMessage("book R7 for two nights for Ada");
  await runTurnWith(businessPackage, [{ toolCalls: [requestConfirmation(parameters)] }]);
  await postCustomerMessage(db, taskId, "yes", { confirms: await requestedConfirmation(taskId) });
  return taskId;
}

test("request_confirmation ends the turn and shows the customer the normalized parameters", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await taskWithMessage("book R7 for two nights for Ada");

  const { model } = await runTurnWith(businessPackage, [
    {
      toolCalls: [
        requestConfirmation({ ...booking, guest: "  Ada " }),
        { name: "book_room", arguments: booking },
      ],
    },
  ]);

  expect(sent).toEqual([]);
  expect(model.requests).toHaveLength(1);
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER" });
  expect((await listUserVisibleMessages(db, taskId)).at(-1)).toMatchObject({
    seq: 2,
    role: "agent",
    content: "Book R7 for 2 nights?",
    payload: { kind: "confirmation_request", tool: "book_room", parameters: booking },
  });
  expect((await readStepLog(db, taskId)).at(-1)).toMatchObject({
    input: { name: "book_room" },
    output: { error: { code: "NOT_EXECUTED" } },
  });
});

test("a write tool call without the customer's confirmation is refused before anything is written", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await taskWithMessage("book R7 for two nights for Ada");

  const { model } = await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: booking }] },
    { content: "Please confirm the booking first." },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "CONFIRMATION_REQUIRED", message: expect.stringContaining("需要用户确认") },
  });
  expect(sent).toEqual([]);
  expect(await listWriteIntents(db, taskId)).toEqual([]);
});

test("once the customer confirms, one call writes through both operations in order", async () => {
  let taskId = "";
  const statesAtSend: Pick<WriteIntent, "operation" | "state" | "deadline">[][] = [];
  const { sent, businessPackage } = bookingService({
    async onSend() {
      const intents = await listWriteIntents(db, taskId);
      statesAtSend.push(
        intents.map(({ operation, state, deadline }) => ({ operation, state, deadline })),
      );
    },
  });
  taskId = await confirmedTask(businessPackage, booking);

  const { model } = await runTurnWith(
    businessPackage,
    [{ toolCalls: [{ name: "book_room", arguments: booking }] }, { content: "Booked." }],
    { now: () => new Date("2030-01-01T00:00:00.000Z"), writeDeadlineMs: 5000 },
  );

  expect(model.requests[0]?.messages.at(-1)).toEqual({
    role: "user",
    content:
      '{"confirmed":{"parameters":{"guest":"Ada","nights":2,"roomId":"R7"},"tool":"book_room"},"message":"yes"}',
  });
  const deadline = new Date("2030-01-01T00:00:05.000Z");
  const [hold, voucher] = sent;
  expect(sent).toHaveLength(2);
  expect(hold).toMatchObject({ operation: "hold_room", deadline });
  expect(hold?.parameters).toEqual({ customerId: "C1", ...booking });
  expect(voucher).toMatchObject({ operation: "issue_voucher", deadline });
  const holdId = `H-${hold?.operationId.slice(0, 8)}`;
  const voucherId = `V-${voucher?.operationId.slice(0, 8)}`;
  expect(voucher?.parameters).toEqual({ holdId });
  // Each request went out only after its intent was SENT with the deadline it carries.
  expect(statesAtSend).toEqual([
    [{ operation: "hold_room", state: "SENT", deadline }],
    [
      { operation: "hold_room", state: "CONFIRMED", deadline },
      { operation: "issue_voucher", state: "SENT", deadline },
    ],
  ]);
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operationId: hold?.operationId, state: "CONFIRMED", result: { holdId } },
    { operationId: voucher?.operationId, state: "CONFIRMED", result: { voucherId } },
  ]);
  expect(lastToolResult(model.requests[1])).toEqual({
    hold_room: { holdId },
    issue_voucher: { voucherId },
  });
});

test("a confirmation covers only the parameters the customer confirmed", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await confirmedTask(businessPackage, booking);

  const { model } = await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: { ...booking, nights: 3 } }] },
    { content: "Three nights need your confirmation first." },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(sent).toEqual([]);
  expect(await listWriteIntents(db, taskId)).toEqual([]);
});

test("asking to confirm changed parameters makes the earlier confirmation lapse", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await confirmedTask(businessPackage, booking);
  const earlier = await requestedConfirmation(taskId);
  await runTurnWith(businessPackage, [
    { toolCalls: [requestConfirmation({ ...booking, nights: 3 }, "Three nights then?")] },
  ]);
  await postCustomerMessage(db, taskId, "let me think");

  const { model } = await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: booking }] },
    { content: "Shall I book two nights after all?" },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(sent).toEqual([]);
  await expect(postCustomerMessage(db, taskId, "yes", { confirms: earlier })).rejects.toThrow(
    ConfirmationNotPendingError,
  );
});

test("a business rejection ends the write: the intent is REJECTED and the model gets the reason", async () => {
  const rejection = { code: "ROOM_TAKEN", message: "R7 is taken for those nights" };
  const { sent, businessPackage } = bookingService({ rejections: { hold_room: rejection } });
  const taskId = await confirmedTask(businessPackage, booking);

  const { model } = await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: booking }] },
    { toolCalls: [{ name: "book_room", arguments: booking }] },
    { content: "Sorry, R7 is taken." },
  ]);

  const refused = { error: { ...rejection, operation: "hold_room" } };
  expect(lastToolResult(model.requests[1])).toEqual(refused);
  // Calling again does not send again: the rejection stands.
  expect(lastToolResult(model.requests[2])).toEqual(refused);
  expect(sent.map((write) => write.operation)).toEqual(["hold_room"]);
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operation: "hold_room", state: "REJECTED", error: rejection },
  ]);
});

test("an intent still PREPARED is sent with newly confirmed parameters under its original operation ID", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await confirmedTask(businessPackage, booking);
  const crash = new Error("executor dropped right after PREPARED");
  const crashing = createExecutor({
    db,
    owner: "executor-1",
    businessPackage,
    model: createScriptedModel([{ toolCalls: [{ name: "book_room", arguments: booking }] }]),
    onFaultPoint(point) {
      if (point.name === "after_prepared") {
        throw crash;
      }
    },
  });
  await expect(crashing.runOnce()).rejects.toThrow(crash);
  const [prepared] = await listWriteIntents(db, taskId);
  expect(prepared).toMatchObject({ operation: "hold_room", state: "PREPARED" });

  // Stand-ins for the watchdog's takeover (#8) and a reconfirm disposition (#14).
  await database.pool.query(
    "UPDATE tasks SET state = 'READY', owner = NULL, lease_until = NULL WHERE id = $1",
    [taskId],
  );
  await database.pool.query("UPDATE confirmations SET status = 'INVALIDATED' WHERE task_id = $1", [
    taskId,
  ]);
  const changed = { ...booking, nights: 3 };
  const resumed = await runTurnWith(
    businessPackage,
    [{ toolCalls: [requestConfirmation(changed, "Three nights instead?")] }],
    { owner: "executor-2" },
  );
  // The interrupted call ran again and was refused before anything was sent.
  expect(lastToolResult(resumed.model.requests[0])).toMatchObject({
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(sent).toEqual([]);
  await postCustomerMessage(db, taskId, "yes, three", {
    confirms: await requestedConfirmation(taskId),
  });

  await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: changed }] },
    { content: "Booked for three nights." },
  ]);

  expect(sent.map(({ operation, operationId }) => [operation, operationId])).toEqual([
    ["hold_room", prepared?.operationId],
    ["issue_voucher", expect.any(String)],
  ]);
  expect(sent[0]?.parameters).toEqual({ customerId: "C1", ...changed });
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operationId: prepared?.operationId, state: "CONFIRMED", parameters: sent[0]?.parameters },
    { operation: "issue_voucher", state: "CONFIRMED" },
  ]);
});

test("running the call again after its first operation took effect writes only the second", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await confirmedTask(businessPackage, booking);
  const crash = new Error("executor dropped between the two writes");
  const crashing = createExecutor({
    db,
    owner: "executor-1",
    businessPackage,
    model: createScriptedModel([{ toolCalls: [{ name: "book_room", arguments: booking }] }]),
    onFaultPoint(point) {
      if (point.name === "after_write_confirmed" && point.operation === "hold_room") {
        throw crash;
      }
    },
  });
  await expect(crashing.runOnce()).rejects.toThrow(crash);
  // Stand-in for the watchdog's takeover (#8).
  await database.pool.query(
    "UPDATE tasks SET state = 'READY', owner = NULL, lease_until = NULL WHERE id = $1",
    [taskId],
  );

  const { model } = await runTurnWith(businessPackage, [{ content: "Booked." }], {
    owner: "executor-2",
  });

  expect(sent.map((write) => write.operation)).toEqual(["hold_room", "issue_voucher"]);
  const holdId = `H-${sent[0]?.operationId.slice(0, 8)}`;
  expect(sent[1]?.parameters).toEqual({ holdId });
  expect(lastToolResult(model.requests[0])).toEqual({
    hold_room: { holdId },
    issue_voucher: { voucherId: `V-${sent[1]?.operationId.slice(0, 8)}` },
  });
  expect((await listWriteIntents(db, taskId)).map((intent) => intent.state)).toEqual([
    "CONFIRMED",
    "CONFIRMED",
  ]);
});

test("an operation that took effect is not passed off as done for other parameters", async () => {
  const { sent, businessPackage } = bookingService();
  const taskId = await confirmedTask(businessPackage, booking);
  const changed = { ...booking, nights: 3 };
  await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: booking }] },
    { toolCalls: [requestConfirmation(changed, "Make it three nights?")] },
  ]);
  await postCustomerMessage(db, taskId, "yes", { confirms: await requestedConfirmation(taskId) });

  const { model } = await runTurnWith(businessPackage, [
    { toolCalls: [{ name: "book_room", arguments: changed }] },
    { content: "R7 is already booked for two nights." },
  ]);

  expect(lastToolResult(model.requests[1])).toMatchObject({
    error: { code: "WRITE_ALREADY_DONE", operation: "hold_room" },
  });
  expect(sent.map((write) => write.operation)).toEqual(["hold_room", "issue_voucher"]);
  expect(await listWriteIntents(db, taskId)).toMatchObject([
    { operation: "hold_room", state: "CONFIRMED", parameters: { nights: 2 } },
    { operation: "issue_voucher", state: "CONFIRMED" },
  ]);
});
