import type { z } from "zod";

// What a business package plugs into the kernel. The kernel knows nothing about the business
// beyond these declarations.

export type Volatility = "stable" | "volatile";

export interface ToolContext {
  taskId: string;
  customerId: string;
  signal: AbortSignal;
}

export interface ToolError {
  code: string;
  message: string;
  // For a write tool: the write operation the error is about.
  operation?: string;
}

// An error outcome is passed to the model as a structured error, not thrown.
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: ToolError };

export interface ReadToolDeclaration<Parameters extends z.ZodType = z.ZodType> {
  kind: "read";
  name: string;
  description: string;
  parameters: Parameters;
  // Of the most volatile part of the result; a tool is not split to separate volatilities.
  volatility: Volatility;
  run(parameters: z.output<Parameters>, context: ToolContext): Promise<ToolOutcome>;
}

export interface WriteRequest<Parameters = unknown> {
  // This operation's own parameters, exactly as its write intent records them.
  parameters: Parameters;
  operationId: string;
  // Business (logical) time after which the business service must not commit the write.
  deadline: Date;
  signal: AbortSignal;
}

export type WriteOutcome =
  // Committed, by this request or by an earlier one with the same operation ID.
  | { status: "done"; result: unknown }
  // A business rule refused it; nothing was committed.
  | { status: "rejected"; error: ToolError };

export interface WriteOperationContext {
  customerId: string;
  // Results of the operations before this one, in order.
  earlier: readonly unknown[];
}

export interface WriteOperationDeclaration<ToolParameters = unknown, Parameters = unknown> {
  // The operation type, part of its operation ID.
  name: string;
  // This operation's own parameters, a JSON value: recorded in its intent and sent as recorded.
  parameters(tool: ToolParameters, context: WriteOperationContext): Parameters;
  send(request: WriteRequest<Parameters>): Promise<WriteOutcome>;
}

// One call writes through its operations in order, under one confirmation (ADR 0003).
export interface WriteToolDeclaration<Parameters extends z.ZodType = z.ZodType> {
  kind: "write";
  name: string;
  description: string;
  // Its output is the normalized form: what the customer confirms and the confirmation binds.
  parameters: Parameters;
  // What the first operation acts on. With the task and the operation type it derives that
  // operation's ID; each later operation's ID derives from the one before it.
  identity(parameters: z.output<Parameters>): unknown;
  operations: readonly WriteOperationDeclaration<z.output<Parameters>>[];
}

export type ToolDeclaration = ReadToolDeclaration | WriteToolDeclaration;

export interface BusinessPackage {
  systemPrompt: string;
  tools: readonly ToolDeclaration[];
}

// Keeps the parameter type of `run` tied to the schema at the declaration site.
export function defineReadTool<Parameters extends z.ZodType>(
  declaration: ReadToolDeclaration<Parameters>,
): ToolDeclaration {
  return declaration;
}

export function defineWriteTool<Parameters extends z.ZodType>(
  declaration: WriteToolDeclaration<Parameters>,
): ToolDeclaration {
  return declaration;
}

// Keeps the parameter type of `send` tied to what `parameters` produces.
export function defineWriteOperation<ToolParameters, Parameters>(
  declaration: WriteOperationDeclaration<ToolParameters, Parameters>,
): WriteOperationDeclaration<ToolParameters> {
  return declaration;
}
