import { describe, expect, it } from "vitest";
import { wordDiff } from "./wordDiff";

describe("wordDiff", () => {
  it("identical texts are one same-span", () => {
    expect(wordDiff("Rebuilt the pipeline", "Rebuilt the pipeline")).toEqual([
      { kind: "same", text: "Rebuilt the pipeline" },
    ]);
  });

  it("marks rephrased spans: additions and removals around the common core", () => {
    expect(
      wordDiff("Rebuilt the pipeline in Go", "Rebuilt the fast pipeline"),
    ).toEqual([
      { kind: "same", text: "Rebuilt the" },
      { kind: "added", text: "fast" },
      { kind: "same", text: "pipeline" },
      { kind: "removed", text: "in Go" },
    ]);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "now here")).toEqual([{ kind: "added", text: "now here" }]);
    expect(wordDiff("gone now", "")).toEqual([{ kind: "removed", text: "gone now" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("collapses whitespace differences into word terms", () => {
    expect(wordDiff("a  b\n c", "a b c")).toEqual([{ kind: "same", text: "a b c" }]);
  });
});
