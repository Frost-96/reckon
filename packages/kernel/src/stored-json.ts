// A value as it reads back from a jsonb column, so what is used live equals what is rebuilt.
export function asStoredJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? "null");
}
