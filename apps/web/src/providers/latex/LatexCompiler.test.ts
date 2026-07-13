import { describe, expect, it } from "vitest";
import {
  pickCompileTimeout,
  TECTONIC_COLD_TIMEOUT_MS,
  TECTONIC_TIMEOUT_MS,
} from "./LatexCompiler";

// The render route's cold/warm ceiling choice (§4.9, decision 51) — pinned as a
// pure function so a mutation that drops the unwarmed→cold branch (silently
// killing slow-link first compiles at 180s) can't ship green.

describe("pickCompileTimeout", () => {
  it("warm compile without a re-warm gets the short --only-cached ceiling", () => {
    expect(pickCompileTimeout(true, false)).toBe(TECTONIC_TIMEOUT_MS);
    expect(pickCompileTimeout(true, undefined)).toBe(TECTONIC_TIMEOUT_MS);
  });

  it("an UNWARMED first compile gets the long network-open ceiling", () => {
    expect(pickCompileTimeout(false, false)).toBe(TECTONIC_COLD_TIMEOUT_MS);
    expect(pickCompileTimeout(false, undefined)).toBe(TECTONIC_COLD_TIMEOUT_MS);
  });

  it("an explicit re-warm gets the long ceiling even when warmed", () => {
    expect(pickCompileTimeout(true, true)).toBe(TECTONIC_COLD_TIMEOUT_MS);
    expect(pickCompileTimeout(false, true)).toBe(TECTONIC_COLD_TIMEOUT_MS);
  });

  it("the two ceilings are distinct (180s vs 600s)", () => {
    expect(TECTONIC_TIMEOUT_MS).toBe(180_000);
    expect(TECTONIC_COLD_TIMEOUT_MS).toBe(600_000);
  });
});
