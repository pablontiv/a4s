export interface SSEEvent {
  event: string;
  data: string;
}

// Feed decoded chunks, not lines: CRLF, UTF-8 and event boundaries may span reads.
export class SSEParser {
  private line = "";
  private event = "message";
  private data: string[] = [];
  private afterCR = false;

  constructor(private readonly emit: (event: SSEEvent) => void) {}

  feed(chunk: string): void {
    for (const char of chunk) {
      if (this.afterCR) {
        this.afterCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeLine();
        this.afterCR = char === "\r";
      } else {
        this.line += char;
      }
    }
  }

  private consumeLine(): void {
    const line = this.line;
    this.line = "";
    if (line === "") {
      if (this.data.length) this.emit({ event: this.event, data: this.data.join("\n") });
      this.event = "message";
      this.data = [];
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value || "message";
    if (field === "data") this.data.push(value);
  }
}
