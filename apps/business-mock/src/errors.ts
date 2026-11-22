import { z } from "zod";

// An error the mock answers with `{ error: { code, message } }` and the given status code.
export class Rejection extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// A write refused by a business rule; nothing is committed and the idempotency key stays free.
export function businessRejection(code: string, message: string): Rejection {
  return new Rejection(422, code, message);
}

export const timestamp = z.iso.datetime({ offset: true });

export function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Rejection(400, "INVALID_REQUEST", result.error.message);
  }
  return result.data;
}
