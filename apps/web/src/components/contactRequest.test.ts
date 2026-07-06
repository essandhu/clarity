import { describe, expect, it } from "vitest";
import { ContactRequestSchema, pastedListingRef, type SourceRef } from "@/shared/schema";
import { buildContactRequest } from "./contactRequest";

const pastedRef = pastedListingRef("2026-07-06T12:00:00.000Z");
const webRef = (url: string): SourceRef => ({
  url,
  label: url,
  fetchedAt: "2026-07-06T12:00:01.000Z",
});

const profile = {
  company: "Acme Robotics",
  role: "Backend Engineer",
  namedTechnologies: [],
  rawText: "Acme Robotics is hiring.",
};

describe("buildContactRequest", () => {
  it("folds the sparse tiers record into a schema-valid coverage array, in tier order", () => {
    const request = buildContactRequest(profile, {
      2: { status: "found", sources: [webRef("https://github.com/acme")] },
      0: { status: "found", sources: [pastedRef] },
      3: { status: "not_found", sources: [] },
    });
    expect(() => ContactRequestSchema.parse(request)).not.toThrow();
    expect(request.coverage.tiers.map((tier) => tier.tier)).toEqual([0, 2, 3]);
    expect(request.coverage.tiers[0].sources).toEqual([pastedRef]);
  });

  it("produces an empty coverage for a run with no tier frames", () => {
    const request = buildContactRequest(profile, {});
    expect(request.coverage.tiers).toEqual([]);
    expect(() => ContactRequestSchema.parse(request)).not.toThrow();
  });
});
