import { describe, expect, it } from "vitest";
import { createSseParser } from "./parseSse";

// Chunk-boundary torture tests (PLAN.md §2): the network is allowed to split
// frames anywhere — including mid-byte inside a multi-byte UTF-8 character.

const encode = (s: string) => new TextEncoder().encode(s);

describe("createSseParser — whole frames", () => {
  it("parses one complete frame", () => {
    const parser = createSseParser();
    const frames = parser.push(encode('id: 0\nevent: run.started\ndata: {"a":1}\n\n'));
    expect(frames).toEqual([{ id: "0", event: "run.started", data: '{"a":1}' }]);
  });

  it("parses multiple frames in a single chunk", () => {
    const parser = createSseParser();
    const frames = parser.push(encode("id: 0\ndata: one\n\nid: 1\ndata: two\n\n"));
    expect(frames.map((f) => f.data)).toEqual(["one", "two"]);
    expect(frames.map((f) => f.id)).toEqual(["0", "1"]);
  });

  it("joins multiple data lines with newlines (SSE spec)", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\ndata: b\n\n")[0].data).toBe("a\nb");
  });

  it("handles values without a space after the colon", () => {
    const parser = createSseParser();
    expect(parser.push("data:x\n\n")[0].data).toBe("x");
  });

  it("drops comments, unknown fields, and data-less blocks", () => {
    const parser = createSseParser();
    expect(parser.push(": keep-alive\n\n")).toEqual([]);
    expect(parser.push("event: lonely\nretry: 3000\n\n")).toEqual([]);
    // ...and the dropped block does not leak its event name into the next one
    expect(parser.push("data: later\n\n")).toEqual([{ id: undefined, event: undefined, data: "later" }]);
  });
});

describe("createSseParser — split frames", () => {
  it("buffers a frame split across three chunks", () => {
    const parser = createSseParser();
    expect(parser.push("id: 4\neve")).toEqual([]);
    expect(parser.push("nt: heartbeat\ndata: {}")).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ id: "4", event: "heartbeat", data: "{}" }]);
  });

  it("survives a split INSIDE a multi-byte UTF-8 character", () => {
    const payload = '{"text":"café ☕ — naïve"}';
    const bytes = encode(`data: ${payload}\n\n`);
    // Split inside the ☕ (a 3-byte character): find its first byte and cut after it.
    const cupStart = payload.indexOf("☕");
    const splitAt = encode(`data: ${payload.slice(0, cupStart)}`).length + 1;
    const parser = createSseParser();
    expect(parser.push(bytes.slice(0, splitAt))).toEqual([]);
    const frames = parser.push(bytes.slice(splitAt));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe(payload);
  });

  it("handles CRLF line endings, including a CR at a chunk boundary", () => {
    const parser = createSseParser();
    expect(parser.push("id: 9\r")).toEqual([]); // might be half a CRLF — must wait
    const frames = parser.push("\nevent: e\r\ndata: d\r\n\r\n");
    expect(frames).toEqual([{ id: "9", event: "e", data: "d" }]);
  });

  it("keeps the remainder after a frame for the next push", () => {
    const parser = createSseParser();
    const first = parser.push("data: one\n\nid: 7\ndata: tw");
    expect(first.map((f) => f.data)).toEqual(["one"]);
    expect(parser.push("o\n\n")).toEqual([{ id: "7", event: undefined, data: "two" }]);
  });
});
