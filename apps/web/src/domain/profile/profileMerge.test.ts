import { describe, expect, it } from "vitest";
import {
  emptyMasterProfile,
  type ExperienceEntry,
  type ImportedEntries,
  type MasterProfile,
} from "@/shared/schema";
import { mergeImportedEntries } from "./profileMerge";

const NOW = "2026-07-12T00:00:00.000Z";

function entries(overrides: Partial<ImportedEntries> = {}): ImportedEntries {
  return { experience: [], projects: [], education: [], skills: [], ...overrides };
}

function experience(id: string, org: string, role: string, startDate?: string): ExperienceEntry {
  return {
    id,
    org,
    role,
    ...(startDate !== undefined ? { startDate } : {}),
    bullets: [],
    provenance: { origin: "pasted-resume", importedAt: NOW },
  };
}

function base(): MasterProfile {
  return emptyMasterProfile("Maya Chen", NOW);
}

describe("mergeImportedEntries", () => {
  it("appends new entries and stamps updatedAt", () => {
    const result = mergeImportedEntries(
      base(),
      entries({ experience: [experience("e1", "Driftlock", "Engineer")] }),
      "2026-07-12T01:00:00.000Z",
    );
    expect(result.profile.experience).toHaveLength(1);
    expect(result.profile.updatedAt).toBe("2026-07-12T01:00:00.000Z");
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("suppresses experience duplicates by org+role+dates, case/space-insensitively", () => {
    const withOne = mergeImportedEntries(
      base(),
      entries({ experience: [experience("e1", "Driftlock", "Engineer", "Jan 2020")] }),
      NOW,
    ).profile;
    const result = mergeImportedEntries(
      withOne,
      entries({
        experience: [
          experience("e2", "  driftlock ", "ENGINEER", "Jan 2020"), // duplicate
          experience("e3", "Driftlock", "Engineer", "Jun 2016"), // different dates — kept
        ],
      }),
      NOW,
    );
    expect(result.profile.experience).toHaveLength(2);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("suppresses project duplicates by name and education by school+degree", () => {
    const profile = {
      ...base(),
      projects: [
        {
          id: "p1",
          name: "driftviz",
          technologies: [],
          bullets: [],
          provenance: { origin: "manual" as const, importedAt: NOW },
        },
      ],
      education: [
        {
          id: "ed1",
          school: "University of Lisbon",
          degree: "BSc Computer Science",
          provenance: { origin: "manual" as const, importedAt: NOW },
        },
      ],
    };
    const result = mergeImportedEntries(
      profile,
      entries({
        projects: [
          {
            id: "p2",
            name: "Driftviz",
            technologies: ["TS"],
            bullets: [],
            provenance: { origin: "pasted-resume", importedAt: NOW },
          },
        ],
        education: [
          {
            id: "ed2",
            school: "university of lisbon",
            degree: "BSc Computer Science",
            provenance: { origin: "pasted-resume", importedAt: NOW },
          },
        ],
      }),
      NOW,
    );
    expect(result.profile.projects).toHaveLength(1);
    expect(result.profile.education).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("unions skill items into a same-category group without duplicating items", () => {
    const profile = {
      ...base(),
      skills: [{ id: "s1", category: "Languages", items: ["Go", "TypeScript"] }],
    };
    const result = mergeImportedEntries(
      profile,
      entries({
        skills: [
          { id: "s2", category: "languages", items: ["go", "Python"] },
          { id: "s3", category: "Tools", items: ["Postgres"] },
        ],
      }),
      NOW,
    );
    expect(result.profile.skills).toEqual([
      { id: "s1", category: "Languages", items: ["Go", "TypeScript", "Python"] },
      { id: "s3", category: "Tools", items: ["Postgres"] },
    ]);
    expect(result.added).toBe(2); // Python + the Tools group
    expect(result.skipped).toBe(1); // go
  });

  it("respects the profile caps, counting overflow as skipped", () => {
    const full = {
      ...base(),
      education: Array.from({ length: 10 }, (_, i) => ({
        id: `ed${i}`,
        school: `School ${i}`,
        provenance: { origin: "manual" as const, importedAt: NOW },
      })),
    };
    const result = mergeImportedEntries(
      full,
      entries({
        education: [
          {
            id: "new",
            school: "One Too Many",
            provenance: { origin: "pasted-resume", importedAt: NOW },
          },
        ],
      }),
      NOW,
    );
    expect(result.profile.education).toHaveLength(10);
    expect(result.skipped).toBe(1);
  });

  it("does not mutate the IMPORTED entries and is idempotent across re-invocation (F4 — StrictMode double-invoke)", () => {
    const profile = base();
    // The grounding fallback can legally mint two groups with the same
    // category — the second must merge into a COPY, never the caller's object.
    const imported = entries({
      skills: [
        { id: "s1", category: "Skills", items: ["Go"] },
        { id: "s2", category: "Skills", items: ["Go", "Python"] },
      ],
    });
    const before = JSON.stringify(imported);
    const first = mergeImportedEntries(profile, imported, NOW);
    expect(JSON.stringify(imported)).toBe(before);
    const second = mergeImportedEntries(profile, imported, NOW);
    expect(second.added).toBe(first.added);
    expect(second.skipped).toBe(first.skipped);
    expect(second.profile).toEqual(first.profile);
    expect(first.profile.skills).toEqual([{ id: "s1", category: "Skills", items: ["Go", "Python"] }]);
  });

  it("a zero-add merge returns the profile UNCHANGED — no updatedAt bump, no phantom dirty (F12)", () => {
    const withEntry = mergeImportedEntries(
      base(),
      entries({ experience: [experience("e1", "Driftlock", "Engineer", "Jan 2020")] }),
      NOW,
    ).profile;
    const result = mergeImportedEntries(
      withEntry,
      entries({ experience: [experience("e2", "Driftlock", "Engineer", "Jan 2020")] }),
      "2026-07-13T09:00:00.000Z",
    );
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.profile).toBe(withEntry); // same reference — snapshot-identical
  });

  it("does not mutate the input profile (the editor's dirty diff depends on it)", () => {
    const profile = {
      ...base(),
      skills: [{ id: "s1", category: "Languages", items: ["Go"] }],
    };
    const before = JSON.stringify(profile);
    mergeImportedEntries(
      profile,
      entries({ skills: [{ id: "s2", category: "Languages", items: ["Python"] }] }),
      NOW,
    );
    expect(JSON.stringify(profile)).toBe(before);
  });
});
