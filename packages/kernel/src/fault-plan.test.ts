import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import {
  type BusinessPackage,
  createExecutor,
  createRun,
  createTask,
  defineWriteTool,
  type ExecutionDb,
  type FaultPoint,
  faultPlanOfRun,
  getTask,
  listFaultFirings,
  listUserVisibleMessages,
  modelOfRun,
  type PlannedFault,
  postCustomerMessage,
} from "./index.ts";
import {
  type ExecutionTestDatabase,
  startExecutionTestDatabase,
  sweepUntilExpired,
} from "./testing.ts";

let database: ExecutionTestDatabase;
let db: ExecutionDb;

beforeAll(async () => {
  database = await startExecutionTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.close();
});

// Holding a room, then issuing a voucher for the hold; records every request it receives.
function bookingService() {
  const sent: string[] = [];
  const businessPackage: BusinessPackage = {
    systemPrompt: "You book rooms.",
    tools: [
      defineWriteTool({
        kind: "write",
        name: "book_room",
        description: "Hold a room and issue its voucher",
        parameters: z.object({ roomId: z.string() }),
        identity: ({ roomId }) => ({ roomId }),
        operations: [
          {
            name: "hold_room",
            parameters: (booking) => booking,
            async send() {
              sent.push("hold_room");
              return { status: "done", result: { holdId: "H1" } };
            },
          },
          {
            name: "issue_voucher",
            parameters: (_booking, { earlier }) => ({ hold: earlier[0] }),
            async send() {
              sent.push("issue_voucher");
              return { status: "done", result: { voucherId: "V1" } };
            },
          },
        ],
      }),
    ],
  };
  return { sent, businessPackage };
}

const booking = { roomId: "R7" };
const bookingTurns = [
  [
    {
      toolCalls: [
        {
          name: "request_confirmation",
          arguments: { tool: "book_room", parameters: booking, message: "Book R7?" },
        },
      ],
    },
  ],
  [{ toolCalls: [{ name: "book_room", arguments: booking }] }, { content: "Booked." }],
];

class Dropped extends Error {}

// Executors serving runs as the executor process does, except that a planned fault drops the
// instance by throwing instead of killing the process. Records which points fired.
function executors(businessPackage: BusinessPackage) {
  const fired: FaultPoint[] = [];
  const executor = (owner: string) =>
    createExecutor({
      db,
      owner,
      businessPackage,
      model: modelOfRun(db),
      leaseSeconds: 0.5,
      heartbeatIntervalMs: 100,
      onFaultPoint: faultPlanOfRun({
        db,
        owner,
        fire(point) {
          fired.push(point);
          throw new Dropped(`${owner} dropped at ${point.name}`);
        },
      }),
    });
  return { fired, executor };
}

// Turn 1 asks to confirm the booking; the customer confirms, which starts turn 2.
async function confirmedBooking(
  faultPlan: PlannedFault[],
  first: ReturnType<typeof createExecutor>,
) {
  const run = await createRun(db, {
    scenario: "book-a-room",
    config: { model: { kind: "scripted", turns: bookingTurns }, faultPlan },
  });
  const task = await createTask(db, { customerId: "C1", runId: run.id });
  await postCustomerMessage(db, task.id, "book R7");
  expect(await first.runOnce()).toEqual({ taskId: task.id, result: "waiting_user" });
  const request = (await listUserVisibleMessages(db, task.id)).at(-1);
  await postCustomerMessage(db, task.id, "yes", { confirms: request?.seq ?? 0 });
  return { runId: run.id, taskId: task.id };
}

test("a planned fault point drops the executor the first time the run reaches it, and never again in that run", async () => {
  const { sent, businessPackage } = bookingService();
  const { fired, executor } = executors(businessPackage);
  const first = executor("executor-1");
  const { runId, taskId } = await confirmedBooking([{ point: "after_write_confirmed" }], first);

  await expect(first.runOnce()).rejects.toThrow(Dropped);
  await sweepUntilExpired(db, taskId);
  // The peer passes the same point after the second write, and goes on.
  expect(await executor("executor-2").runOnce()).toEqual({ taskId, result: "waiting_user" });

  expect(fired).toMatchObject([{ name: "after_write_confirmed", operation: "hold_room" }]);
  expect(await listFaultFirings(db, runId)).toEqual([
    {
      runId,
      faultPoint: "after_write_confirmed",
      taskId,
      owner: "executor-1",
      firedAt: expect.any(Date),
    },
  ]);
  expect(sent).toEqual(["hold_room", "issue_voucher"]);
  expect(await getTask(db, taskId)).toMatchObject({ state: "WAITING_USER" });
  expect((await listUserVisibleMessages(db, taskId)).at(-1)).toMatchObject({ content: "Booked." });
});

test("a planned fault point narrowed to one write operation fires only after that operation", async () => {
  const { sent, businessPackage } = bookingService();
  const { fired, executor } = executors(businessPackage);
  const first = executor("executor-1");
  const { runId, taskId } = await confirmedBooking(
    [{ point: "after_write_confirmed", target: "issue_voucher" }],
    first,
  );

  await expect(first.runOnce()).rejects.toThrow(Dropped);
  await sweepUntilExpired(db, taskId);
  expect(await executor("executor-2").runOnce()).toEqual({ taskId, result: "waiting_user" });

  expect(fired).toMatchObject([{ name: "after_write_confirmed", operation: "issue_voucher" }]);
  expect(await listFaultFirings(db, runId)).toMatchObject([
    { faultPoint: "after_write_confirmed:issue_voucher", owner: "executor-1" },
  ]);
  expect(sent).toEqual(["hold_room", "issue_voucher"]);
  expect((await listUserVisibleMessages(db, taskId)).at(-1)).toMatchObject({ content: "Booked." });
});
