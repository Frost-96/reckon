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

export type ToolDeclaration = ReadToolDeclaration;

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
