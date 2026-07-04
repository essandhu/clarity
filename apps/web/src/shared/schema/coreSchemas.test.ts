import { describe, expect, it } from "vitest";
import { AnalyzeInputSchema } from "./analyzeInput";
import { BriefingSectionSchema } from "./briefing";
import { ContactCandidateSchema } from "./contact";
import { DraftNoteSchema } from "./draftNote";
import { FetchSkipSchema } from "./fetch";
import { HookSchema } from "./hook";
import { ListingProfileSchema } from "./listingProfile";
import { PASTED_LISTING_URL, pastedListingRef, SourceRefSchema } from "./sourceRef";

const fetchedRef = {
  url: "https://acme.dev/careers",
  label: "Careers — Acme",
  fetchedAt: "2026-07-03T12:00:00Z",
};

describe("SourceRef", () => {
  it("accepts a real fetched URL", () => {
    expect(SourceRefSchema.parse(fetchedRef)).toEqual(fetchedRef);
  });

  it("accepts the canonical pasted-listing ref and nothing else non-http", () => {
    const ref = pastedListingRef("2026-07-03T12:00:00Z");
    expect(SourceRefSchema.parse(ref).url).toBe(PASTED_LISTING_URL);
    // WHATWG URL parsing admits any scheme — the schema must not. Citation
    // links render as hrefs, so only http(s) or the canonical literal pass.
    expect(
      SourceRefSchema.safeParse({ ...ref, url: "listing:typed" }).success,
    ).toBe(false);
    expect(
      SourceRefSchema.safeParse({ ...ref, url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});

describe("ListingProfile", () => {
  it("parses a hand-written sparse-startup fixture", () => {
    const profile = ListingProfileSchema.parse({
      company: "Acme Robotics",
      role: "Senior Backend Engineer",
      namedTechnologies: ["TypeScript", "Postgres"],
      rawText: "Acme Robotics is hiring a Senior Backend Engineer…",
    });
    expect(profile.company).toBe("Acme Robotics");
    // Missing optionals stay absent — never invented.
    expect(profile.domain).toBeUndefined();
    expect(profile.seniority).toBeUndefined();
  });

  it("rejects a non-http(s) listingUrl — the hardening covers every fetchable field", () => {
    expect(
      ListingProfileSchema.safeParse({
        company: "Acme",
        role: "Engineer",
        rawText: "short",
        listingUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("defaults namedTechnologies to [] and caps rawText at 20k", () => {
    const parsed = ListingProfileSchema.parse({
      company: "Acme",
      role: "Engineer",
      rawText: "short",
    });
    expect(parsed.namedTechnologies).toEqual([]);
    expect(
      ListingProfileSchema.safeParse({
        company: "Acme",
        role: "Engineer",
        rawText: "x".repeat(20_001),
      }).success,
    ).toBe(false);
  });
});

describe("FetchSkip", () => {
  it("rejects an unknown skip reason", () => {
    expect(
      FetchSkipSchema.safeParse({ kind: "skip", reason: "mercury_retrograde" })
        .success,
    ).toBe(false);
  });

  it("allows a pipeline-produced skip with no url", () => {
    expect(
      FetchSkipSchema.parse({ kind: "skip", reason: "cancelled" }).url,
    ).toBeUndefined();
  });

  it("round-trips a fully-populated fetcher-produced skip", () => {
    // The wire's most common degradation frame: fetcher skips always carry url.
    const skip = {
      kind: "skip" as const,
      url: "https://acme.dev/careers",
      reason: "http_status" as const,
      detail: "Not Found",
      httpStatus: 404,
    };
    expect(FetchSkipSchema.parse(skip)).toEqual(skip);
  });
});

describe("BriefingSection", () => {
  it("rejects confidence 'medium' — the scale is high|low|none", () => {
    expect(
      BriefingSectionSchema.safeParse({
        id: "stack",
        title: "Stack",
        content: "TypeScript on the backend.",
        confidence: "medium",
        sources: [fetchedRef],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown section id — the section plan is fixed", () => {
    expect(
      BriefingSectionSchema.safeParse({
        id: "vibes",
        title: "Vibes",
        content: "Good.",
        confidence: "high",
        sources: [fetchedRef],
      }).success,
    ).toBe(false);
  });
});

describe("Hook", () => {
  it("cannot exist uncited", () => {
    expect(
      HookSchema.safeParse({
        text: "They shipped X",
        basis: "changelog entry",
        confidence: "high",
        sources: [],
      }).success,
    ).toBe(false);
  });

  it("accepts a listing-grounded hook citing the pasted-listing ref", () => {
    const hook = HookSchema.parse({
      text: "The listing says the team owns the billing rewrite",
      basis: "stated directly in the listing",
      confidence: "low",
      sources: [pastedListingRef("2026-07-03T12:00:00Z")],
    });
    expect(hook.sources[0]!.url).toBe(PASTED_LISTING_URL);
  });

  it("rejects confidence 'none' — a hook is always grounded in something", () => {
    expect(
      HookSchema.safeParse({
        text: "t",
        basis: "b",
        confidence: "none",
        sources: [fetchedRef],
      }).success,
    ).toBe(false);
  });
});

describe("ContactCandidate", () => {
  it("accepts a paste-path listing contact citing the pasted-listing ref", () => {
    const candidate = ContactCandidateSchema.parse({
      name: "Sam Recruiter",
      channel: "listing",
      value: "recruiting@acme.dev",
      confidence: "public",
      source: pastedListingRef("2026-07-03T12:00:00Z"),
    });
    expect(candidate.source.url).toBe(PASTED_LISTING_URL);
  });

  it("source is mandatory — even a guess must say where the name came from", () => {
    expect(
      ContactCandidateSchema.safeParse({
        channel: "inferred-email",
        value: "sam.recruiter@acme.dev",
        confidence: "guess",
      }).success,
    ).toBe(false);
  });
});

describe("DraftNote / AnalyzeInput", () => {
  it("round-trips a draft note", () => {
    expect(
      DraftNoteSchema.parse({ body: "Hi —", groundedHooks: [] }).groundedHooks,
    ).toEqual([]);
  });

  it("round-trips both input kinds and rejects too-short pasted text", () => {
    const urlInput = { kind: "url" as const, url: "https://jobs.acme.dev/123" };
    const textInput = { kind: "text" as const, text: "x".repeat(40) };
    expect(AnalyzeInputSchema.parse(urlInput)).toEqual(urlInput);
    expect(AnalyzeInputSchema.parse(textInput)).toEqual(textInput);
    expect(
      AnalyzeInputSchema.safeParse({ kind: "text", text: "too short" }).success,
    ).toBe(false);
  });

  it("rejects non-http(s) listing URLs — user input gets fetched server-side", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.dev/a"]) {
      expect(AnalyzeInputSchema.safeParse({ kind: "url", url }).success).toBe(
        false,
      );
    }
  });
});
