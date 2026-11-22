import { canonicalHash } from "@reckon/shared";

// Document numbers depend only on the scenario seed and the writer's operation ID, so every
// run of a scenario shows the model the same numbers and recorded responses replay.
export function deriveDocumentId(prefix: "AS" | "RS", seed: string, clientRef: string): string {
  const digest = canonicalHash({ kind: prefix, seed, clientRef });
  return `${prefix}-${digest.slice(0, 12).toUpperCase()}`;
}
