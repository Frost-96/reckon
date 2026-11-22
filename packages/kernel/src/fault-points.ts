// Named semantic events where a fault plan can drop the executor. A hook that throws there ends
// the turn as a crash would: nothing after the last checkpoint is kept, the lease is left to expire.
export type FaultPoint = {
  // after_write_confirmed: an operation took effect and its CONFIRMED is checkpointed, so for a
  // first operation this is between the two writes.
  name: "after_prepared" | "after_write_confirmed";
  taskId: string;
  operation: string;
  operationId: string;
};

export type FaultPointHook = (point: FaultPoint) => void | Promise<void>;
