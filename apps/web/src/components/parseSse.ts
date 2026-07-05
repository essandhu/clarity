// Incremental SSE frame parser (PLAN.md §6 Transport). Fed raw network chunks;
// partial frames — and even multi-byte UTF-8 characters split across chunk
// boundaries — are buffered until complete. Pure and dependency-free so the
// torture tests need no DOM and no network.

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export interface SseParser {
  /** Feed one network chunk; returns every frame completed by it. */
  push(chunk: Uint8Array | string): SseFrame[];
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const dispatch = (): SseFrame | undefined => {
    // Per the SSE spec, a blank line with no accumulated data dispatches
    // nothing (comment-only or event-only blocks are dropped).
    const frame = data.length > 0 ? { id, event, data: data.join("\n") } : undefined;
    id = undefined;
    event = undefined;
    data = [];
    return frame;
  };

  const processLine = (line: string): SseFrame | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined; // comment (proxy keep-alives)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        data.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      default:
        // Unknown fields (e.g. retry) are ignored.
        break;
    }
    return undefined;
  };

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const frames: SseFrame[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        let line: string;
        if (ch === "\n") {
          line = buffer.slice(start, i);
        } else if (ch === "\r") {
          // A trailing CR might be half of a CRLF split across chunks — wait.
          if (i + 1 === buffer.length) break;
          line = buffer.slice(start, i);
          if (buffer[i + 1] === "\n") i += 1;
        } else {
          continue;
        }
        start = i + 1;
        const frame = processLine(line);
        if (frame) frames.push(frame);
      }
      buffer = buffer.slice(start);
      return frames;
    },
  };
}
