import { describe, expect, it } from "vitest";
import type { ImportExtraction } from "@/shared/schema";
import {
  dateTokensAppear,
  groundImportExtraction,
  IMPORT_FALLBACK_CATEGORY,
  normalizeForMatch,
} from "./resumeImportGrounding";

const PASTE = [
  "Maya Chen — Software Engineer",
  "maya@example.com · Lisbon, Portugal",
  "",
  "EXPERIENCE",
  "Driftlock — Senior Software Engineer   Jan 2020 – Present",
  "- Rebuilt the ingestion pipeline in Go, cutting p99 latency",
  "  from 900ms to 120ms",
  "- Mentored four engineers through the platform migration",
  "",
  "Acme Corp — Software Engineer   Jun 2016 – Dec 2019",
  "- Shipped the billing reconciliation service",
  "",
  "PROJECTS",
  "driftviz — real-time drift visualizer (TypeScript, D3)",
  "- Renders a million points at 60fps",
  "",
  "EDUCATION",
  "University of Lisbon — BSc Computer Science, 2012 – 2016",
  "",
  "SKILLS",
  "Languages: Go, TypeScript, Python",
  "Tools: Postgres, Kafka",
].join("\n");

function extraction(overrides: Partial<ImportExtraction> = {}): ImportExtraction {
  return { experience: [], projects: [], education: [], skills: [], ...overrides };
}

describe("groundImportExtraction", () => {
  it("keeps entries whose every string appears verbatim (whitespace/case-normalized)", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          {
            org: "Driftlock",
            role: "Senior Software Engineer",
            startDate: "Jan 2020",
            // The paste wraps this bullet across two lines — whitespace
            // collapse must let the single-line extraction ground.
            bullets: [
              "Rebuilt the ingestion pipeline in Go, cutting p99 latency from 900ms to 120ms",
            ],
          },
        ],
      }),
      PASTE,
    );
    expect(result.droppedStrings).toEqual([]);
    expect(result.extraction.experience).toHaveLength(1);
    expect(result.extraction.experience[0].bullets).toHaveLength(1);
  });

  it("drops a fabricated bullet with its path and keeps the rest of the entry", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          {
            org: "Driftlock",
            role: "Senior Software Engineer",
            bullets: [
              "Mentored four engineers through the platform migration",
              "Led the company to a 40% revenue increase", // fabricated
            ],
          },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience[0].bullets).toEqual([
      "Mentored four engineers through the platform migration",
    ]);
    expect(result.droppedStrings).toEqual([
      {
        path: "experience[0].bullets[1]",
        text: "Led the company to a 40% revenue increase",
        reason: "not-verbatim",
      },
    ]);
  });

  it("drops the WHOLE entry when a fatal key (org) is fabricated, naming it", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          {
            org: "Driftlock Industries", // not what the paste says
            role: "Senior Software Engineer",
            bullets: ["Mentored four engineers through the platform migration"],
          },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience).toEqual([]);
    expect(result.droppedStrings).toContainEqual({
      path: "experience[0].org",
      text: "Driftlock Industries",
      reason: "not-verbatim",
    });
  });

  it("drops a garbled date to ABSENT (digit-run rule) and reports it — the qwen3 garble class", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          {
            org: "Driftlock",
            role: "Senior Software Engineer",
            startDate: "Jan 2002", // paste says Jan 2020; "2002" appears nowhere
            bullets: [],
          },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience[0].startDate).toBeUndefined();
    expect(result.droppedStrings).toContainEqual({
      path: "experience[0].startDate",
      text: "Jan 2002",
      reason: "not-verbatim",
    });
  });

  it("a date alpha token absent from the paste fails too (invented 'Present')", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          { org: "Acme Corp", role: "Software Engineer", endDate: "Currently", bullets: [] },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience[0].endDate).toBeUndefined();
  });

  it("normalizes blank optionals to absent silently (the qwen3 blank-fill artifact)", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          { org: "Driftlock", role: "Senior Software Engineer", location: "", bullets: [] },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience[0].location).toBeUndefined();
    expect(result.droppedStrings).toEqual([]);
  });

  it("gates skill items individually and replaces an invented category with the fallback", () => {
    const result = groundImportExtraction(
      extraction({
        skills: [
          { category: "Cloud Orchestration", items: ["Go", "Kubernetes"] }, // both invented labels
          { category: "Languages", items: ["TypeScript", "Rust"] },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.skills).toEqual([
      { category: IMPORT_FALLBACK_CATEGORY, items: ["Go"] },
      { category: "Languages", items: ["TypeScript"] },
    ]);
    expect(result.droppedStrings).toContainEqual({
      path: "skills[0].items[1]",
      text: "Kubernetes",
      reason: "not-verbatim",
    });
    expect(result.droppedStrings).toContainEqual({
      path: "skills[0].category",
      text: "Cloud Orchestration",
      reason: "not-verbatim",
    });
  });

  it("drops a skills group whose every item failed", () => {
    const result = groundImportExtraction(
      extraction({ skills: [{ category: "Languages", items: ["Haskell", "OCaml"] }] }),
      PASTE,
    );
    expect(result.extraction.skills).toEqual([]);
  });

  it("education and projects ride the same gate (school fatal, project name fatal)", () => {
    const result = groundImportExtraction(
      extraction({
        education: [
          { school: "University of Lisbon", degree: "BSc Computer Science" },
          { school: "Stanford University" }, // fabricated
        ],
        projects: [
          { name: "driftviz", technologies: ["TypeScript", "D3"], bullets: [] },
          { name: "quantflow", technologies: [], bullets: [] }, // fabricated
        ],
      }),
      PASTE,
    );
    expect(result.extraction.education).toHaveLength(1);
    expect(result.extraction.projects).toHaveLength(1);
    expect(result.droppedStrings.map((d) => d.path)).toEqual(
      expect.arrayContaining(["education[1].school", "projects[1].name"]),
    );
  });
});

describe("normalizeForMatch / dateTokensAppear", () => {
  it("collapses whitespace, folds case, and NFC-normalizes", () => {
    expect(normalizeForMatch("  Senior   Software\nEngineer ")).toBe("senior software engineer");
    expect(normalizeForMatch("Café")).toBe(normalizeForMatch("Café"));
  });

  it("date rule: all digit runs and alpha tokens must appear", () => {
    const haystack = normalizeForMatch("Worked Jan 2020 – Present at Driftlock");
    expect(dateTokensAppear("Jan 2020", haystack)).toBe(true);
    expect(dateTokensAppear("Present", haystack)).toBe(true);
    expect(dateTokensAppear("Jan 2002", haystack)).toBe(false);
    expect(dateTokensAppear("Feb 2020", haystack)).toBe(false);
  });

  it("date rule matches WHOLE tokens — fragments and longer digit runs do not ground (F2)", () => {
    const haystack = normalizeForMatch("decreased revenue in 2019; zip 20024; junior doctor");
    expect(dateTokensAppear("Dec 2019", haystack)).toBe(false); // 'dec' only inside 'decreased'
    expect(dateTokensAppear("Jun 2019", haystack)).toBe(false); // 'jun' only inside 'junior'
    expect(dateTokensAppear("Oct 2019", haystack)).toBe(false); // 'oct' only inside 'doctor'
    expect(dateTokensAppear("2002", haystack)).toBe(false); // only inside '20024'
    expect(dateTokensAppear("2019", haystack)).toBe(true); // whole token
  });

  it("date rule grounds month names across abbreviation forms (Jan ⇄ January)", () => {
    const haystack = normalizeForMatch("January 2020 – March 2021");
    expect(dateTokensAppear("Jan 2020", haystack)).toBe(true);
    expect(dateTokensAppear("Mar 2021", haystack)).toBe(true);
    expect(dateTokensAppear("Feb 2020", haystack)).toBe(false);
  });

  it("date rule never passes vacuously: non-ASCII digits and absent symbols fail (F2)", () => {
    const haystack = normalizeForMatch("Jan 2020 – 2028");
    expect(dateTokensAppear("２０２８", haystack)).toBe(false); // full-width garble ≠ '2028'
    expect(dateTokensAppear("????", haystack)).toBe(false); // symbols-only, absent
    expect(dateTokensAppear("–", haystack)).toBe(true); // symbols-only, literally present
  });
});

describe("fatal-key entries still name every failed string (F3)", () => {
  it("reports a fabricated bullet AND the fabricated org of the SAME dropped entry", () => {
    const result = groundImportExtraction(
      extraction({
        experience: [
          {
            org: "Driftlock Industries", // fabricated — fatal
            role: "Senior Software Engineer",
            bullets: [
              "Mentored four engineers through the platform migration",
              "Achieved 300% revenue growth", // fabricated — must STILL be named
            ],
          },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.experience).toEqual([]);
    const paths = result.droppedStrings.map((drop) => drop.path);
    expect(paths).toContain("experience[0].org");
    expect(paths).toContain("experience[0].bullets[1]");
  });

  it("keptIndices carry ORIGINAL extraction indices past dropped entries (F8)", () => {
    const result = groundImportExtraction(
      extraction({
        education: [
          { school: "University of Lisbon" },
          { school: "Fabricated Academy" }, // dropped
          { school: "University of Lisbon", degree: "BSc Computer Science" },
        ],
      }),
      PASTE,
    );
    expect(result.extraction.education).toHaveLength(2);
    expect(result.keptIndices.education).toEqual([0, 2]);
  });
});
