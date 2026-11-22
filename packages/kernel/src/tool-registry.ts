import { z } from "zod";
import type { BusinessPackage, ToolDeclaration, Volatility } from "./business-package.ts";
import type { ModelToolDefinition } from "./model.ts";

export interface ToolRegistry {
  definitions: ModelToolDefinition[];
  find(name: string): ToolDeclaration | undefined;
}

const volatilities: readonly Volatility[] = ["stable", "volatile"];

// Checked at runtime too: recheck relies on every read tool declaring its volatility.
export function createToolRegistry(businessPackage: BusinessPackage): ToolRegistry {
  const byName = new Map<string, ToolDeclaration>();
  for (const tool of businessPackage.tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is declared more than once`);
    }
    if (!volatilities.includes(tool.volatility)) {
      throw new Error(`Read tool ${tool.name} must declare its volatility as stable or volatile`);
    }
    byName.set(tool.name, tool);
  }
  const definitions = [...byName.values()].map(
    (tool): ModelToolDefinition => ({
      name: tool.name,
      description: tool.description,
      parameters: parameterSchema(tool),
    }),
  );
  return { definitions, find: (name) => byName.get(name) };
}

// What the model must send, so the input side of the schema.
function parameterSchema(tool: ToolDeclaration): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.parameters, { io: "input" });
  return schema;
}
