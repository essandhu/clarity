import { beforeEach, describe, expect, it } from "vitest";
import type { ListingProfile } from "@/shared/schema";
import { consumeTailorHandoff, storeTailorHandoff } from "./tailorHandoff";

// Decision 54's read-once contract (review F14): round-trip, single
// consumption, and corrupt-payload tolerance — sessionStorage stubbed the
// way jsdom would provide it.

const backing = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
} as Storage;

const profile: ListingProfile = {
  company: "Tessellate",
  role: "Platform Engineer",
  namedTechnologies: ["Go"],
  rawText: "Tessellate is hiring a Platform Engineer.",
};

describe("tailorHandoff", () => {
  beforeEach(() => backing.clear());

  it("round-trips a stored profile exactly once — the second consume is null", () => {
    storeTailorHandoff(profile);
    expect(consumeTailorHandoff()).toEqual(profile);
    expect(consumeTailorHandoff()).toBeNull();
    expect(backing.size).toBe(0);
  });

  it("consumes corrupt JSON silently — removed, never re-offered", () => {
    backing.set("clarity:tailor-handoff", "{not json");
    expect(consumeTailorHandoff()).toBeNull();
    expect(backing.size).toBe(0);
  });

  it("rejects a wrong-shape payload (zod-parsed, corrupt ⇒ ignored)", () => {
    backing.set("clarity:tailor-handoff", JSON.stringify({ profile: { company: "x" } }));
    expect(consumeTailorHandoff()).toBeNull();
  });

  it("returns null when nothing was stored", () => {
    expect(consumeTailorHandoff()).toBeNull();
  });
});
