import { runTurn } from "./agent-loop.ts";
import type { BusinessPackage } from "./business-package.ts";
import type { ExecutionDb } from "./db/database.ts";
import type { FaultPointHook } from "./fault-points.ts";
import { claimTask, type Lease, LeaseLostError, renewLease } from "./lease.ts";
import type { ModelClient } from "./model.ts";
import { createToolRegistry } from "./tool-registry.ts";

// Chooses the model for a claimed task, e.g. the scripted fake its run brings (modelOfRun).
export type ModelForTask = (task: {
  taskId: string;
  runId: string | null;
}) => ModelClient | Promise<ModelClient>;

export interface ExecutorOptions {
  db: ExecutionDb;
  // Identifies this executor instance as the lease owner.
  owner: string;
  businessPackage: BusinessPackage;
  // One model for every task, or one chosen per claimed task.
  model: ModelClient | ModelForTask;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  // Business (logical) time for write deadlines (ADR 0002); the wall clock by default.
  now?: () => Date;
  // Δ, the deadline a write request carries, counted from when it is sent.
  writeDeadlineMs?: number;
  // Called at each named fault point; throwing there drops the turn like a crash.
  onFaultPoint?: FaultPointHook;
  // How long `start` waits before claiming again when nothing was READY.
  pollIntervalMs?: number;
  // Errors that do not stop the executor: a failed heartbeat (retried) or a failed turn.
  onError?: (error: unknown) => void;
}

export interface TurnOutcome {
  taskId: string;
  // lease_lost: the turn was abandoned; nothing after the last accepted checkpoint was kept.
  result: "waiting_user" | "lease_lost";
}

export interface Executor {
  // Claims one READY task and runs its turn; undefined when nothing is READY.
  runOnce(): Promise<TurnOutcome | undefined>;
  // Keeps claiming and running turns one after another until stopped.
  start(): void;
  // Stops claiming and waits for the turn in progress to finish.
  stop(): Promise<void>;
}

export function createExecutor(options: ExecutorOptions): Executor {
  const leaseSeconds = options.leaseSeconds ?? 10;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const tools = createToolRegistry(options.businessPackage);

  async function runClaimed(lease: Lease): Promise<TurnOutcome> {
    const controller = new AbortController();
    const heartbeat = startHeartbeat(
      () => renewLease(options.db, lease, leaseSeconds),
      heartbeatIntervalMs,
      () => controller.abort(new LeaseLostError(lease.taskId)),
      onError,
    );
    try {
      const model =
        typeof options.model === "function"
          ? await options.model({ taskId: lease.taskId, runId: lease.runId })
          : options.model;
      await runTurn({
        db: options.db,
        lease,
        systemPrompt: options.businessPackage.systemPrompt,
        tools,
        model,
        signal: controller.signal,
        now: options.now ?? (() => new Date()),
        writeDeadlineMs: options.writeDeadlineMs ?? 5000,
        onFaultPoint: options.onFaultPoint ?? (() => {}),
      });
      return { taskId: lease.taskId, result: "waiting_user" };
    } catch (error) {
      // The signal is aborted only on lease loss; a tool may surface that as its own abort error.
      if (error instanceof LeaseLostError || controller.signal.aborted) {
        return { taskId: lease.taskId, result: "lease_lost" };
      }
      // Anything else leaves the lease to expire, as if this executor had crashed.
      throw error;
    } finally {
      await heartbeat.stop();
    }
  }

  // Calls queue behind each other, so this executor never holds two leases at once.
  let previous: Promise<unknown> = Promise.resolve();
  function runOnce(): Promise<TurnOutcome | undefined> {
    const run = previous.then(async () => {
      const lease = await claimTask(options.db, options.owner, leaseSeconds);
      return lease === undefined ? undefined : runClaimed(lease);
    });
    previous = run.catch(() => {});
    return run;
  }

  let loop: Promise<void> | undefined;
  let stopping = false;
  let wake = () => {};
  async function poll(): Promise<void> {
    while (!stopping) {
      let outcome: TurnOutcome | undefined;
      try {
        outcome = await runOnce();
      } catch (error) {
        onError(error);
      }
      if (outcome === undefined && !stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }

  return {
    runOnce,
    start() {
      if (loop === undefined) {
        stopping = false;
        loop = poll();
      }
    },
    async stop() {
      stopping = true;
      wake();
      await loop;
      loop = undefined;
    },
  };
}

// Renews on its own timer, independent of step progress.
function startHeartbeat(
  renew: () => Promise<boolean>,
  intervalMs: number,
  onLost: () => void,
  onError: (error: unknown) => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = Promise.resolve();
  const beat = () => {
    inFlight = (async () => {
      try {
        if (!(await renew())) {
          stopped = true;
          onLost();
          return;
        }
      } catch (error) {
        onError(error);
      }
      if (!stopped) {
        timer = setTimeout(beat, intervalMs);
      }
    })();
  };
  timer = setTimeout(beat, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
