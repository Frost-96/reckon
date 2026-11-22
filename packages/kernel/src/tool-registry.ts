import { z } from "zod";
import type { BusinessPackage, ToolDeclaration, Volatility } from "./business-package.ts";
import { askUser, type InteractionTool, requestConfirmation } from "./interaction.ts";
import type { ModelToolDefinition } from "./model.ts";

export type RegisteredTool = ToolDeclaration | InteractionTool;

export interface ToolRegistry {
  definitions: ModelToolDefinition[];
  find(name: string): RegisteredTool | undefined;
}

const volatilities: readonly Volatility[] = ["stable", "volatile"];
const reservedNames: readonly string[] = ["ask_user", "request_confirmation"];

// Checked at runtime too: recheck relies on every read tool declaring its volatility.
export function createToolRegistry(businessPackage: BusinessPackage): ToolRegistry {
  const writeTools = businessPackage.tools.filter((tool) => tool.kind === "write");
  const builtIns: InteractionTool[] =
    writeTools.length === 0 ? [askUser] : [askUser, requestConfirmation(writeTools)];
  const byName = new Map<string, RegisteredTool>();
  for (const tool of businessPackage.tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is declared more than once`);
    }
    if (reservedNames.includes(tool.name)) {
      throw new Error(`Tool name ${tool.name} is reserved for the kernel`);
    }
    if (tool.kind === "read" && !volatilities.includes(tool.volatility)) {
      throw new Error(`Read tool ${tool.name} must declare its volatility as stable or volatile`);
    }
    byName.set(tool.name, tool);
  }
  for (const builtIn of builtIns) {
    byName.set(builtIn.name, builtIn);
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
function parameterSchema(tool: RegisteredTool): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.parameters, { io: "input" });
  return schema;
}
