/** One JSON message per line (NDJSON). Works over stdio, named pipes and WebSocket text frames. */
export const encodeLine = (msg: unknown): string => JSON.stringify(msg) + "\n";

export const MAX_LINE_CHARS = 2_000_000;

/** Reassembles lines from arbitrary chunks. Throws if a single line exceeds the limit. */
export class LineDecoder {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) lines.push(line);
    }
    if (this.buf.length > MAX_LINE_CHARS) throw new Error("ipc line too long");
    return lines;
  }
}
