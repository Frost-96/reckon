import type { ToolOutcome, WriteOutcome } from "@reckon/kernel";

// HTTP access to the business service (the mock in experiments).
export interface BusinessService {
  get(path: string, signal: AbortSignal): Promise<ToolOutcome>;
  // A write under the idempotency key; the operation ID serves as the key (ADR 0005).
  post(
    path: string,
    body: unknown,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<WriteOutcome>;
}

const businessErrorStatuses = new Set([404, 422]);

export function createBusinessService(baseUrl: string): BusinessService {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    async get(path, signal) {
      const response = await fetch(new URL(path, base), { signal });
      const body: unknown = await response.json();
      if (response.ok) {
        return { ok: true, value: body };
      }
      // Business answers like "not found" go to the model; anything else is not ours to explain.
      if (businessErrorStatuses.has(response.status) && isBusinessError(body)) {
        return { ok: false, error: body.error };
      }
      throw new Error(`GET ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
    },
    async post(path, requestBody, { idempotencyKey, signal }) {
      const response = await fetch(new URL(path, base), {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(requestBody),
        signal,
      });
      const body: unknown = await response.json();
      if (response.status === 201) {
        return { status: "done", result: body };
      }
      if (response.status === 422 && isBusinessError(body)) {
        return { status: "rejected", error: body.error };
      }
      throw new Error(`POST ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
    },
  };
}

function isBusinessError(body: unknown): body is { error: { code: string; message: string } } {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const { error } = body;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function pathOf(...segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}
