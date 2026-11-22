import { runTurn } from "./agent-loop.ts";
import type { BusinessPackage } from "./business-package.ts";
import type { ExecutionDb } from "./db/database.ts";
import { claimTask, type Lease, LeaseLostError, renewLease } from "./lease.ts";
import type { ModelClient } from "./model.ts";
import { createToolRegistry } from "./tool-registry.ts";

export interface ExecutorOptions {
  db: ExecutionDb;
  // Identifies this executor instance as the lease owner.
  owner: string;
  businessPackage: BusinessPackage;
  model: ModelClient;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  // Errors that do not end the turn, e.g. a failed heartbeat that will be retried.
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
}

export function createExecutor(options: ExecutorOptions): Executor {
  const leaseSeconds = options.leaseSeconds ?? 10;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000;
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
      await runTurn({
        db: options.db,
        lease,
        systemPrompt: options.businessPackage.systemPrompt,
        tools,
        model: options.model,
        signal: controller.signal,
      });
      return { taskId: lease.taskId, result: "waiting_user" };
    } catch (error) {
      if (error instanceof LeaseLostError) {
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
  return {
    runOnce() {
      const run = previous.then(async () => {
        const lease = await claimTask(options.db, options.owner, leaseSeconds);
        return lease === undefined ? undefined : runClaimed(lease);
      });
      previous = run.catch(() => {});
      return run;
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
