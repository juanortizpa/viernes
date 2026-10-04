import { describe, expect, it } from "vitest";
import { ClientMessage, LineDecoder, ServerMessage, encodeLine } from "../src";

describe("framing", () => {
  it("reassembles lines split across chunks and skips blanks", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n\n')).toEqual(['{"b":2}']);
  });

  it("rejects an unterminated oversized line", () => {
    expect(() => new LineDecoder().push("x".repeat(1_000_001))).toThrow();
  });

  it("encodes one message per line", () => {
    expect(encodeLine({ type: "task.cancel" })).toBe('{"type":"task.cancel"}\n');
  });
});

describe("messages", () => {
  it("applies defaults and rejects bad shapes", () => {
    expect(ClientMessage.parse({ type: "task.submit", input: "hola" })).toMatchObject({ modality: "text" });
    expect(ClientMessage.safeParse({ type: "task.submit", input: "" }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: "hello", token: "t", protocol: 2 }).success).toBe(false);
    expect(ServerMessage.safeParse({ type: "event", event: { type: "nope" } }).success).toBe(false);
  });
});
