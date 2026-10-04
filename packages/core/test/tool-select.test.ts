import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "@jarvis/protocol";
import { compactSchema, selectTools } from "../src";

const tool = (name: string, description = ""): ToolDescriptor => ({ name, description, risk: "read", reversible: true, verifiable: false, inputSchema: { type: "object" } });
const all = ["web.search", "web.fetch", "apps.open", "time.now", "files.read", "files.write", "code.agent", "code.changes", "aliases.learn", "memory.list", "assistant.capabilities"].map((n) => tool(n));
const offered = (q: string, extra: ToolDescriptor[] = []) => selectTools([...all, ...extra], q).map((t) => t.name);

describe("selectTools (ADR-0029)", () => {
  it("a plain question gets only the small core", () => {
    expect(offered("¿cuál es la capital de Francia?")).toEqual(["web.search", "web.fetch", "apps.open", "time.now"]);
  });
  it("words of the request bring in what it needs", () => {
    expect(offered("leé el archivo C:\notas\todo.txt")).toEqual(expect.arrayContaining(["files.read", "files.write"]));
    expect(offered("arreglá el bug del login en mi proyecto")).toEqual(expect.arrayContaining(["code.agent", "code.changes"]));
    expect(offered("¿qué podés hacer?")).toContain("assistant.capabilities");
    expect(offered("arreglá el bug")).not.toContain("files.read");
  });
  it("MCP tools come in by server name or a shared meaningful word", () => {
    const gh = [tool("mcp.github.search_issues", "[MCP github] Search issues in a repository"), tool("mcp.github.create_pr", "[MCP github] Create a pull request")];
    expect(offered("buscá issues abiertos", gh)).toContain("mcp.github.search_issues");
    expect(offered("buscá issues abiertos", gh)).not.toContain("mcp.github.create_pr");
    expect(offered("en github, creá un PR", gh)).toEqual(expect.arrayContaining(["mcp.github.search_issues", "mcp.github.create_pr"]));
    expect(offered("¿qué hora es?", gh).some((n) => n.startsWith("mcp."))).toBe(false);
  });
  it("compact schemas drop only metadata", () => {
    expect(compactSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, properties: { a: { type: "string", additionalProperties: false } }, required: ["a"] })).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(compactSchema({ additionalProperties: { type: "string" } })).toEqual({ additionalProperties: { type: "string" } });
  });
});
