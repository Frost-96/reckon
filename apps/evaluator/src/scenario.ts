import { readFile } from "node:fs/promises";
import { aftersalesStatuses, orderStatuses } from "@reckon/business-mock/schema";
import { runConfigSchema } from "@reckon/kernel";
import { z } from "zod";

const id = z.string().min(1);

// The business initial data, reset into the business mock before the run.
const businessData = z
  .object({
    policy: z
      .object({
        returnWindowDays: z.int().nonnegative(),
        returnFeeCents: z.int().nonnegative(),
      })
      .strict(),
    orders: z.array(
      z
        .object({
          id,
          customerId: id,
          status: z.enum(orderStatuses),
          // Counted back from the run's start, so a scenario does not age out of the return window.
          deliveredDaysAgo: z.number().nonnegative(),
          lines: z
            .array(z.object({ id, productName: id, quantity: z.int().positive() }).strict())
            .min(1),
        })
        .strict(),
    ),
    // Applications already on file, typically someone else's.
    aftersales: z
      .array(
        z
          .object({
            id,
            orderId: id,
            lineId: id,
            quantity: z.int().positive(),
            reason: id,
            status: z.enum(aftersalesStatuses),
            returnFeeCents: z.int().nonnegative().optional(),
            clientRef: id.nullable().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

// Declarative rules: the simulated user never improvises.
const simulatedUser = z
  .object({
    customerId: id,
    // The opening message, then one more after each plain reply of the agent. After the last
    // one is answered, the user ends the session.
    messages: z.array(z.string().min(1)).min(1),
    // The answer to the agent's question, by the slot the question fills: a fixed text, or the
    // one offered option containing the given text (the text itself when nothing is offered).
    answers: z
      .record(
        z.string(),
        z.union([z.string().min(1), z.object({ choose: z.string().min(1) }).strict()]),
      )
      .default({}),
    // What the user agrees to. A confirmation request for anything else is refused.
    confirmations: z.array(z.object({ tool: id, parameters: z.unknown() }).strict()).default([]),
    confirmationReply: z.string().min(1).default("确认"),
  })
  .strict();

export const outcomeCategories = [
  "auto_completed",
  "reconfirmed",
  "stopped",
  "handed_off",
] as const;
export type OutcomeCategory = (typeof outcomeCategories)[number];

// Judged on the business database, never on what the agent said.
const aftersalesAssertion = z
  .object({
    kind: z.literal("aftersales"),
    orderId: id,
    lineId: id,
    // Exactly this many aftersales orders on the line, seeded ones included unless excluded.
    count: z.int().nonnegative(),
    // False: only the records written during the run count, and only they need the fields below.
    includeSeeded: z.boolean().default(true),
    // Each of them has these, where given.
    quantity: z.int().positive().optional(),
    returnFeeCents: z.int().nonnegative().optional(),
    status: z.enum(aftersalesStatuses).optional(),
    returnShipment: z.boolean().optional(),
  })
  .strict();

export type BusinessAssertion = z.output<typeof aftersalesAssertion>;

export const scenarioSchema = z
  .object({
    name: id,
    description: z.string().optional(),
    // Business document numbers derive from it, so every run sees the same ones.
    seed: id,
    business: businessData,
    simulatedUser,
    // The scripted fake model: per turn, the responses to that turn's model calls in order.
    model: z.object({ turns: runConfigSchema.shape.model.shape.turns }).strict(),
    expected: z
      .object({
        outcome: z.enum(outcomeCategories),
        business: z.array(aftersalesAssertion),
      })
      .strict(),
  })
  .strict();

export type Scenario = z.output<typeof scenarioSchema>;
export type SimulatedUser = Scenario["simulatedUser"];

export class InvalidScenarioError extends Error {
  constructor(source: string, detail: string) {
    super(`Invalid scenario ${source}:\n${detail}`);
    this.name = "InvalidScenarioError";
  }
}

export function parseScenario(json: unknown, source = "(inline)"): Scenario {
  const result = scenarioSchema.safeParse(json);
  if (!result.success) {
    throw new InvalidScenarioError(source, z.prettifyError(result.error));
  }
  return result.data;
}

export async function loadScenario(path: string): Promise<Scenario> {
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new InvalidScenarioError(path, String(error));
  }
  return parseScenario(json, path);
}

const dayMs = 24 * 60 * 60 * 1000;

// The business mock's fixture, with times fixed relative to `start`.
export function businessFixture(business: Scenario["business"], start: Date) {
  return {
    ...business,
    orders: business.orders.map(({ deliveredDaysAgo, ...order }) => ({
      ...order,
      deliveredAt: new Date(start.getTime() - deliveredDaysAgo * dayMs).toISOString(),
    })),
  };
}
