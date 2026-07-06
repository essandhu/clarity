import { describe, expect, it } from "vitest";
import type { ContactSource } from "@/providers/contact/ContactSource";
import { pastedListingRef, type ContactCandidate } from "@/shared/schema";
import {
  MAX_CANDIDATES,
  rankCandidates,
  stripPhoneShapes,
  surfaceContacts,
} from "./ContactSurfacer";

const ref = pastedListingRef("2026-07-06T12:00:00.000Z");

const candidate = (overrides: Partial<ContactCandidate>): ContactCandidate => ({
  channel: "listing",
  confidence: "public",
  source: ref,
  ...overrides,
});

describe("stripPhoneShapes", () => {
  it("deletes US and international phone shapes (§7: no phone numbers)", () => {
    expect(stripPhoneShapes("Call (555) 123-4567 or apply")).toBe("Call or apply");
    expect(stripPhoneShapes("Jane +44 20 7946 0958")).toBe("Jane");
    expect(stripPhoneShapes("555.123.4567")).toBe("");
  });

  it("keeps short digit runs — years and team sizes are not phones", () => {
    expect(stripPhoneShapes("Founded 2019, team of 20")).toBe("Founded 2019, team of 20");
  });

  it("leaves URLs alone — encoded digits are not a phone number", () => {
    const url = "https://www.linkedin.com/search/results/people/?keywords=Jane%20Doe";
    expect(stripPhoneShapes(url)).toBe(url);
  });
});

describe("rankCandidates", () => {
  it("sorts verified > public > guess, stable within a band", () => {
    const ranked = rankCandidates([
      candidate({ channel: "inferred-email", confidence: "guess", value: "g1@acme.dev" }),
      candidate({ value: "public1@acme.dev" }),
      candidate({ channel: "linkedin", confidence: "guess", value: "https://linkedin.example/x" }),
      candidate({ channel: "careers", value: "public2@acme.dev" }),
    ]);
    expect(ranked.map((c) => c.value)).toEqual([
      "public1@acme.dev",
      "public2@acme.dev",
      "g1@acme.dev",
      "https://linkedin.example/x",
    ]);
  });

  it("dedupes the same value across channels, keeping the higher confidence", () => {
    const ranked = rankCandidates([
      candidate({ channel: "inferred-email", confidence: "guess", value: "jane@acme.dev" }),
      candidate({ channel: "careers", confidence: "public", value: "jane@acme.dev" }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].channel).toBe("careers");
    expect(ranked[0].confidence).toBe("public");
  });

  it("dedupes value case-insensitively and valueless candidates by channel+name", () => {
    const ranked = rankCandidates([
      candidate({ value: "Jane@Acme.dev" }),
      candidate({ channel: "careers", value: "jane@acme.dev" }),
      candidate({ channel: "careers", name: "Jane Doe", value: undefined }),
      candidate({ channel: "careers", name: "jane doe", value: undefined }),
    ]);
    expect(ranked).toHaveLength(2);
  });

  it("caps at MAX_CANDIDATES", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      candidate({ value: `person${i}@acme.dev` }),
    );
    expect(rankCandidates(many)).toHaveLength(MAX_CANDIDATES);
  });

  it("phone-strips every field and drops a candidate left with nothing to show", () => {
    const ranked = rankCandidates([
      candidate({ name: "Jane Doe", role: "Recruiter, +1 (555) 123-4567", value: "555 123 4567" }),
      candidate({ value: "(555) 123-4567" }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ name: "Jane Doe", role: "Recruiter,", value: undefined });
  });
});

describe("surfaceContacts", () => {
  it("concatenates sources in order and applies the ranking pipeline", async () => {
    const makeSource = (id: string, results: ContactCandidate[]): ContactSource => ({
      id,
      find: async () => results,
    });
    const out = await surfaceContacts(
      { company: "Acme", role: "Engineer", namedTechnologies: [], rawText: "listing text" },
      { tiers: [] },
      [
        makeSource("a", [
          candidate({ channel: "inferred-email", confidence: "guess", value: "guess@acme.dev" }),
        ]),
        makeSource("b", [candidate({ value: "real@acme.dev" })]),
      ],
    );
    expect(out.map((c) => c.value)).toEqual(["real@acme.dev", "guess@acme.dev"]);
  });
});
