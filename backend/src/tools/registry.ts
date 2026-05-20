import * as fs from "fs";
import * as path from "path";

// ===== Tool Parameter =====

export interface ToolParamDef {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

// ===== Tool =====

export type ToolExecutor = (args: Record<string, unknown>) => string | Promise<string>;

export class Tool {
  constructor(
    public name: string,
    public description: string,
    public parameters: ToolParamDef[],
    public fn: ToolExecutor
  ) {}

  toOpenAIFormat(): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of this.parameters) {
      const schema: Record<string, unknown> = {
        type: p.type,
        description: p.description,
      };
      if (p.default !== undefined) schema.default = p.default;
      properties[p.name] = schema;
      if (p.required !== false) required.push(p.name);
    }
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties, required },
      },
    };
  }
}

// ===== Tool Registry =====

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  toOpenAITools(): Record<string, unknown>[] {
    return this.getAll().map((t) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const params = t.parameters || [];
      for (const p of params) {
        properties[p.name] = {
          type: p.type,
          description: p.description,
        };
        if (p.default !== undefined) (properties[p.name] as Record<string, unknown>).default = p.default;
        if (p.required !== false) required.push(p.name);
      }
      const result: Record<string, unknown> = {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object",
            properties,
            required,
            additionalProperties: false,
          },
        },
      };
      return result;
    });
  }
}

// ===== Project Root =====

export function getProjectRoot(): string {
  // backend/src/tools/registry.ts -> backend -> SClaw root
  return path.resolve(__dirname, "..", "..");
}

export function getBackendRoot(): string {
  return path.resolve(__dirname, "..");
}
