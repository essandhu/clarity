import { describe, expect, it } from "vitest";
import {
  PipelineEventSchema,
  type EnrichmentResult,
  type FetchSkipReason,
  type SourceRef,
} from "@/shared/schema";
import {
  capSourceText,
  foldTier,
  SOURCE_TEXT_CAP,
  tierStatus,
  toWireSummary,
  type CandidateOutcome,
} from "./coverage";

const ref = (url: string): SourceRef => ({
  url,
  label: "Acme",
  fetchedAt: "2026-07-05T12:00:00.000Z",
});

const pageOutcome = (url: string, text = "Acme builds robots."): CandidateOutcome => ({
  kind: "page",
  source: ref(url),
  text,
});
const skip = (reason: FetchSkipReason): CandidateOutcome => ({ kind: "skip", reason });

describe("tierStatus — the §4 rule", () => {
  it("found beats everything when at least one page landed", () => {
    expect(tierStatus([skip("network"), pageOutcome("https://acme.dev/")])).toBe("found");
    expect(tierStatus([skip("budget_exhausted"), pageOutcome("https://acme.dev/")])).toBe("found");
  });

  it("skipped_budget only when EVERY candidate was budget-skipped", () => {
    expect(tierStatus([skip("budget_exhausted"), skip("budget_exhausted")])).toBe(
      "skipped_budget",
    );
    expect(tierStatus([skip("budget_exhausted"), skip("network")])).toBe("not_found");
  });

  it("zero candidates is not_found, never skipped_budget", () => {
    expect(tierStatus([])).toBe("not_found");
  });
});

describe("foldTier", () => {
  it("dedups sources by final URL and caps extracted text per source", () => {
    const long = "a".repeat(SOURCE_TEXT_CAP + 500);
    const folded = foldTier(1, [
      pageOutcome("https://acme.dev/", long),
      pageOutcome("https://acme.dev/", "duplicate — two candidates redirected here"),
      pageOutcome("https://acme.dev/about"),
      skip("http_status"),
    ]);
    expect(folded.status).toBe("found");
    expect(folded.sources.map((s) => s.url)).toEqual([
      "https://acme.dev/",
      "https://acme.dev/about",
    ]);
    expect((folded.extracted["https://acme.dev/"] as string).length).toBe(SOURCE_TEXT_CAP);
  });

  it("dedups slash-variant redirect targets by urlKey, not raw string (review finding D)", () => {
    const folded = foldTier(1, [
      pageOutcome("https://acme.dev/careers"),
      // A parallel candidate 301'd to the same page with a trailing slash.
      pageOutcome("https://acme.dev/careers/"),
    ]);
    expect(folded.sources.map((s) => s.url)).toEqual(["https://acme.dev/careers"]);
    expect(Object.keys(folded.extracted)).toEqual(["https://acme.dev/careers"]);
  });

  it("capSourceText strips a slice-severed surrogate", () => {
    const text = `${"a".repeat(SOURCE_TEXT_CAP - 1)}𝄞rest`;
    const capped = capSourceText(text);
    expect(capped.length).toBe(SOURCE_TEXT_CAP - 1);
    expect(capped.endsWith("a")).toBe(true);
  });
});

describe("toWireSummary — counts only (decision 19)", () => {
  const result: EnrichmentResult = {
    tiers: [
      {
        tier: 0,
        status: "found",
        sources: [ref("https://acme.dev/jobs/1")],
        extracted: { "https://acme.dev/jobs/1": "the listing text" },
      },
      { tier: 1, status: "found", sources: [ref("https://acme.dev/")], extracted: {} },
      { tier: 2, status: "skipped_budget", sources: [], extracted: {} },
    ],
    fetchesUsed: 3,
  };

  it("folds to { tier, status, sourceCount } with no sources or extracted text", () => {
    expect(toWireSummary(result)).toEqual({
      tiers: [
        { tier: 0, status: "found", sourceCount: 1 },
        { tier: 1, status: "found", sourceCount: 1 },
        { tier: 2, status: "skipped_budget", sourceCount: 0 },
      ],
      fetchesUsed: 3,
    });
  });

  it("round-trips through the wire schema with counts only — the §7 proof", () => {
    const frame = JSON.parse(
      JSON.stringify({ type: "enrichment.completed", summary: toWireSummary(result) }),
    ) as unknown;
    const parsed = PipelineEventSchema.parse(frame);
    expect(parsed).toEqual({
      type: "enrichment.completed",
      summary: {
        tiers: [
          { tier: 0, status: "found", sourceCount: 1 },
          { tier: 1, status: "found", sourceCount: 1 },
          { tier: 2, status: "skipped_budget", sourceCount: 0 },
        ],
        fetchesUsed: 3,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("the listing text");
    expect(JSON.stringify(parsed)).not.toContain('"sources"');
    expect(JSON.stringify(parsed)).not.toContain('"extracted"');
  });
});
