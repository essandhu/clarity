import { describe, expect, it } from "vitest";
import { createThinkStripper, stripThink, stripThinkStream } from "./thinkStrip";

function run(chunks: string[]): string {
  const stripper = createThinkStripper();
  return chunks.map((c) => stripper.push(c)).join("") + stripper.flush();
}

describe("createThinkStripper", () => {
  it("passes tag-free text through unchanged", () => {
    expect(run(["Hello, ", "world!"])).toBe("Hello, world!");
  });

  it("removes a think block contained in one chunk", () => {
    expect(run(["<think>secret</think>Hello"])).toBe("Hello");
  });

  it("removes a think block whose tags are split across chunk boundaries", () => {
    expect(run(["<thi", "nk>secret reasoning</th", "ink>Hello"])).toBe("Hello");
  });

  it("removes multiple think blocks and keeps surrounding text", () => {
    expect(run(["a<think>x</think>b", "<think>y", "</think>c"])).toBe("abc");
  });

  it("drops an unterminated think block at end of stream", () => {
    expect(run(["before<think>never closed..."])).toBe("before");
  });

  it("emits withheld text that looked like a tag prefix but was not", () => {
    expect(run(["<th", "e end"])).toBe("<the end");
  });

  it("emits a withheld partial tag prefix left at end of stream", () => {
    expect(run(["done<thi"])).toBe("done<thi");
  });

  it("handles a chunk boundary inside the closing tag's angle bracket", () => {
    expect(run(["<think>x</think", ">after"])).toBe("after");
  });
});

describe("stripThink", () => {
  it("strips think blocks from a whole string", () => {
    expect(stripThink("<think>plan</think>Result text")).toBe("Result text");
  });
});

describe("stripThinkStream", () => {
  it("strips split tags across chunks and never yields empty chunks", async () => {
    async function* source(): AsyncIterable<string> {
      yield "<thi";
      yield "nk>secret</th";
      yield "ink>Hel";
      yield "lo";
    }
    const received: string[] = [];
    for await (const chunk of stripThinkStream(source())) {
      received.push(chunk);
    }
    expect(received.join("")).toBe("Hello");
    expect(received.every((c) => c.length > 0)).toBe(true);
  });
});
