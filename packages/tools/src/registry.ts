import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDescriptor } from "@jarvis/protocol";
import type { AnyTool } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** A tool the model may call: it exists and is not reserved for the user's own commands. */
  getForModel(name: string): AnyTool | undefined {
    const t = this.tools.get(name);
    return t && t.modelCallable !== false ? t : undefined;
  }

  describe(tool: AnyTool): ToolDescriptor {
    return {
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      reversible: tool.reversible,
      verifiable: tool.verify !== undefined,
      inputSchema: zodToJsonSchema(tool.input) as Record<string, unknown>,
    };
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => this.describe(t));
  }

  /** What is offered to the model (see `Tool.modelCallable`). */
  listForModel(): ToolDescriptor[] {
    return [...this.tools.values()].filter((t) => t.modelCallable !== false).map((t) => this.describe(t));
  }
}
