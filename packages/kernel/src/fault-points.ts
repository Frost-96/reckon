import { z } from "zod";

export const faultPointNames = [
  "after_read_before_checkpoint",
  "after_prepared",
  "after_write_confirmed",
  "mid_model_stream",
] as const;

// Named semantic events where a fault plan can drop the executor. A hook that throws there ends
// the turn as a crash would: nothing after the last checkpoint is kept, the lease is left to expire.
export type FaultPoint =
  // A read tool's result arrived; its step is not checkpointed yet.
  | { name: "after_read_before_checkpoint"; taskId: string; tool: string }
  | {
      // after_write_confirmed: an operation took effect and its CONFIRMED is checkpointed, so for a
      // first operation this is between the two writes.
      name: "after_prepared" | "after_write_confirmed";
      taskId: string;
      operation: string;
      operationId: string;
    }
  // A model call has pushed its first text fragment as a draft and is not complete yet.
  | { name: "mid_model_stream"; taskId: string };

export type FaultPointHook = (point: FaultPoint) => void | Promise<void>;

// One fault point of a run's fault plan.
export const plannedFaultSchema = z
  .object({
    point: z.enum(faultPointNames),
    // Narrows the point to one read tool or one write operation, by name.
    target: z.string().min(1).optional(),
  })
  .strict();

export type PlannedFault = z.output<typeof plannedFaultSchema>;

// How a planned fault point is named in its firing record, e.g. "after_write_confirmed:hold_room".
export function faultPointLabel(fault: PlannedFault): string {
  return fault.target === undefined ? fault.point : `${fault.point}:${fault.target}`;
}

// The planned fault point a label names; throws a ZodError for an unknown point.
export function parseFaultPointLabel(label: string): PlannedFault {
  const separator = label.indexOf(":");
  return plannedFaultSchema.parse(
    separator === -1
      ? { point: label }
      : { point: label.slice(0, separator), target: label.slice(separator + 1) },
  );
}

export function reachesPlannedFault(point: FaultPoint, fault: PlannedFault): boolean {
  if (point.name !== fault.point) {
    return false;
  }
  switch (point.name) {
    case "after_read_before_checkpoint":
      return fault.target === undefined || fault.target === point.tool;
    // Nothing to narrow it to: a target there is never reached.
    case "mid_model_stream":
      return fault.target === undefined;
    default:
      return fault.target === undefined || fault.target === point.operation;
  }
}
