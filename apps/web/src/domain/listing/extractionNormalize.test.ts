import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "./extractionNormalize";

const base = { company: "Driftlock", role: "Backend Engineer" };

describe("normalizeExtraction — namedTechnologies dedup (adversarial-review fix)", () => {
  it("drops exact repeats while preserving first-seen order", () => {
    const result = normalizeExtraction({
      ...base,
      namedTechnologies: ["React", "Postgres", "React", "Go", "Postgres"],
    });
    expect(result.namedTechnologies).toEqual(["React", "Postgres", "Go"]);
  });

  it("dedups duplicates that only trimming manufactures", () => {
    const result = normalizeExtraction({
      ...base,
      namedTechnologies: ["Go", "Go ", " Go", "Rust"],
    });
    expect(result.namedTechnologies).toEqual(["Go", "Rust"]);
  });

  it("still trims entries and drops blanks", () => {
    const result = normalizeExtraction({
      ...base,
      namedTechnologies: ["  TypeScript  ", "", "   "],
    });
    expect(result.namedTechnologies).toEqual(["TypeScript"]);
  });
});
