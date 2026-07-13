import { describe, expect, it } from "vitest";
import { ImportedEntriesSchema } from "@/shared/schema";
import {
  linkedinFileKind,
  mapLinkedinRows,
  parseLinkedinDate,
  type LinkedinRows,
} from "./linkedinMapping";

// §4.7 mapping: pure rows -> entries. Date vintages via the pinned format
// list with SURFACED raw-string fallback; PII columns structurally dropped;
// volunteer roles suffixed; over-cap values dropped + reported, not clipped.

let nextId = 0;
const deps = { mintId: () => `id-${nextId++}`, importedAt: "2026-07-12T09:00:00.000Z" };

describe("linkedinFileKind", () => {
  it("normalizes case, underscores, and directory prefixes; matches the drift filename", () => {
    expect(linkedinFileKind("Positions.csv")).toBe("positions");
    expect(linkedinFileKind("export/POSITIONS.CSV")).toBe("positions");
    expect(linkedinFileKind("Volunteer_Experiences.csv")).toBe("volunteering");
    expect(linkedinFileKind("Volunteering.csv")).toBe("volunteering");
    expect(linkedinFileKind("Connections.csv")).toBeUndefined();
    expect(linkedinFileKind("Positions.csv.exe")).toBeUndefined();
    expect(linkedinFileKind("Positions")).toBeUndefined();
  });
});

describe("parseLinkedinDate", () => {
  it("handles all four pinned formats and rejects the rest", () => {
    expect(parseLinkedinDate("Jan 2020")).toBe("Jan 2020");
    expect(parseLinkedinDate("January 2020")).toBe("Jan 2020");
    expect(parseLinkedinDate("2019-06")).toBe("Jun 2019");
    expect(parseLinkedinDate("2020")).toBe("2020");
    expect(parseLinkedinDate("Sometime in 2018")).toBeUndefined();
    expect(parseLinkedinDate("Janvier 2020")).toBeUndefined(); // non-English -> raw fallback
    expect(parseLinkedinDate("2019-13")).toBeUndefined(); // not a month
  });
});

describe("mapLinkedinRows", () => {
  it("maps positions with bullets split on newlines; blank Finished On = current role", () => {
    const { entries } = mapLinkedinRows(
      {
        positions: [
          {
            "Company Name": "Driftlock",
            Title: "Platform Engineer",
            Description: "Built the ingestion pipeline\nCut infra costs 40%",
            Location: "Remote",
            "Started On": "Jan 2020",
            "Finished On": "",
          },
        ],
      },
      deps,
    );
    expect(entries.experience).toHaveLength(1);
    const entry = entries.experience[0]!;
    expect(entry).toMatchObject({
      org: "Driftlock",
      role: "Platform Engineer",
      location: "Remote",
      startDate: "Jan 2020",
      provenance: { origin: "linkedin-export", importedAt: deps.importedAt },
    });
    expect(entry.endDate).toBeUndefined();
    expect(entry.bullets.map((b) => b.text)).toEqual([
      "Built the ingestion pipeline",
      "Cut infra costs 40%",
    ]);
    expect(ImportedEntriesSchema.parse(entries)).toBeTruthy();
  });

  it("normalizes both date vintages and keeps unparseable dates raw WITH a note", () => {
    const { entries, notes } = mapLinkedinRows(
      {
        positions: [
          { "Company Name": "A", Title: "Dev", "Started On": "2019-06", "Finished On": "March 2021" },
          { "Company Name": "B", Title: "Dev", "Started On": "Sometime in 2018", "Finished On": "" },
        ],
      },
      deps,
    );
    expect(entries.experience[0]).toMatchObject({ startDate: "Jun 2019", endDate: "Mar 2021" });
    expect(entries.experience[1]?.startDate).toBe("Sometime in 2018"); // kept, never dropped
    expect(notes.some((note) => note.includes('kept "Sometime in 2018" as written'))).toBe(true);
  });

  it("suffixes volunteer roles and maps their Description to bullets", () => {
    const { entries } = mapLinkedinRows(
      {
        volunteering: [
          {
            "Company Name": "Food Bank",
            Role: "Driver",
            Cause: "Hunger relief",
            "Started On": "2019-06",
            Description: "Weekly deliveries",
          },
        ],
      },
      deps,
    );
    expect(entries.experience[0]).toMatchObject({
      org: "Food Bank",
      role: "Driver (volunteer)",
      startDate: "Jun 2019",
    });
    expect(entries.experience[0]?.bullets.map((b) => b.text)).toEqual(["Weekly deliveries"]);
  });

  it("never lets the pinned PII columns reach the output, on ANY file", () => {
    const { entries, notes, droppedStrings } = mapLinkedinRows(
      {
        profile: [
          {
            "First Name": "Maya",
            "Last Name": "Chen",
            Headline: "Engineer",
            "Birth Date": "1990-01-01",
            Address: "12 Secret Street",
            "Zip Code": "99999",
            "Geo Location": "12.34,56.78",
            "Instant Messengers": "maya_im",
            "Twitter Handles": "@maya",
          },
        ],
        positions: [
          {
            "Company Name": "Acme",
            Title: "Dev",
            Address: "12 Secret Street", // hostile column on a mapped file
          },
        ],
      },
      deps,
    );
    const everything = JSON.stringify({ entries, notes, droppedStrings });
    for (const planted of ["1990-01-01", "12 Secret Street", "99999", "12.34,56.78", "maya_im", "@maya"]) {
      expect(everything).not.toContain(planted);
    }
    expect(entries.experience).toHaveLength(1); // the position itself still mapped
  });

  it("maps education, projects (with URL validation), and the four skill-group kinds", () => {
    const rows: LinkedinRows = {
      education: [
        {
          "School Name": "State University",
          "Degree Name": "BSc Computer Science",
          Notes: "Graduated with honors",
          "Start Date": "2014",
          "End Date": "2018",
        },
      ],
      projects: [
        { Title: "Clarity", Description: "Local-first research tool", Url: "https://github.com/x/clarity" },
        { Title: "BadLink", Url: "javascript:alert(1)" },
      ],
      skills: [{ Name: "TypeScript" }, { Name: "Rust" }],
      certifications: [{ Name: "CKA", Authority: "CNCF" }],
      honors: [{ Title: "Dean's List" }],
      languages: [{ Name: "Spanish", Proficiency: "Professional working" }, { Name: "English" }],
    };
    const { entries, notes } = mapLinkedinRows(rows, deps);

    expect(entries.education[0]).toMatchObject({
      school: "State University",
      degree: "BSc Computer Science",
      notes: "Graduated with honors",
      startDate: "2014",
      endDate: "2018",
    });
    expect(entries.projects[0]).toMatchObject({ name: "Clarity", url: "https://github.com/x/clarity" });
    expect(entries.projects[1]?.url).toBeUndefined(); // javascript: never survives
    expect(notes.some((note) => note.includes("BadLink"))).toBe(true);

    const byCategory = Object.fromEntries(entries.skills.map((g) => [g.category, g.items]));
    expect(byCategory).toEqual({
      Skills: ["TypeScript", "Rust"],
      Certifications: ["CKA"],
      "Honors & Awards": ["Dean's List"],
      Languages: ["Spanish (Professional working)", "English"],
    });
    expect(ImportedEntriesSchema.parse(entries)).toBeTruthy();
  });

  it("drops over-cap values with per-string reports instead of clipping them", () => {
    const longBullet = "x".repeat(501);
    const longSkill = "y".repeat(81);
    const manyLines = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
    const { entries, droppedStrings } = mapLinkedinRows(
      {
        positions: [
          { "Company Name": "Acme", Title: "Dev", Description: `${longBullet}\nkeep me` },
          { "Company Name": "Acme2", Title: "Dev", Description: manyLines },
        ],
        skills: [{ Name: longSkill }, { Name: "ok" }],
      },
      deps,
    );
    expect(entries.experience[0]?.bullets.map((b) => b.text)).toEqual(["keep me"]);
    expect(entries.experience[1]?.bullets).toHaveLength(12); // schema max
    expect(entries.skills[0]?.items).toEqual(["ok"]);
    const reasons = new Set(droppedStrings.map((d) => d.reason));
    expect(reasons).toEqual(new Set(["over-cap"]));
    // 1 long bullet + 2 overflow lines (12-cap) + 1 long skill item
    expect(droppedStrings).toHaveLength(4);
    expect(droppedStrings.every((d) => d.text.length <= 120)).toBe(true);
  });

  it("skips headless rows with a NOTE naming the skip — never silently (review C3)", () => {
    const { entries, notes } = mapLinkedinRows(
      {
        positions: [{ "Company Name": "", Title: "Dev" }, { "Company Name": "Acme", Title: "" }],
        education: [{ "Degree Name": "BSc" }],
      },
      deps,
    );
    expect(entries.experience).toHaveLength(0);
    expect(entries.education).toHaveLength(0);
    expect(notes.filter((n) => n.includes("skipped a row with no Company Name/Title"))).toHaveLength(2);
    expect(notes.some((n) => n.includes("skipped a row with no School Name"))).toBe(true);
  });

  it("an over-cap heading drops the WHOLE row with a row-scoped report (review C3)", () => {
    const longOrg = "z".repeat(201);
    const { entries, droppedStrings } = mapLinkedinRows(
      {
        positions: [
          { "Company Name": longOrg, Title: "Dev", Description: "vanishes with the row" },
          { "Company Name": "Kept Co", Title: "Dev" },
        ],
      },
      deps,
    );
    expect(entries.experience.map((e) => e.org)).toEqual(["Kept Co"]);
    // The report entry is scoped to the ROW (positions[0]) — not a bare
    // .org leaf that would imply the rest of the row survived.
    expect(droppedStrings).toEqual([
      { path: "positions[0]", text: longOrg.slice(0, 120), reason: "over-cap" },
    ]);
  });

  it("report paths are in the SOURCE row-index base — a dropped row never shifts them (review C2)", () => {
    const longBullet = "x".repeat(501);
    const { droppedStrings } = mapLinkedinRows(
      {
        positions: [
          { "Company Name": "y".repeat(201), Title: "Dev" }, // row 0: dropped whole
          { "Company Name": "Acme", Title: "Dev", Description: longBullet }, // row 1: kept, bullet dropped
        ],
        volunteering: [
          { "Company Name": "Food Bank", Role: "Driver", Description: longBullet }, // its OWN file base
        ],
      },
      deps,
    );
    expect(droppedStrings.map((d) => d.path)).toEqual([
      "positions[0]",
      "positions[1].bullets[0]", // row 1 keeps its SOURCE index despite row 0's drop
      "volunteering[0].bullets[0]",
    ]);
  });

  it("chunks skill groups at 30 items under DISTINCT categories so no item can strand at merge (review C4)", () => {
    const { entries } = mapLinkedinRows(
      { skills: Array.from({ length: 65 }, (_, i) => ({ Name: `Skill ${i}` })) },
      deps,
    );
    expect(entries.skills.map((g) => g.items.length)).toEqual([30, 30, 5]);
    expect(entries.skills.map((g) => g.category)).toEqual(["Skills", "Skills (2)", "Skills (3)"]);
  });

  it("all 65 chunked skills survive a merge into an empty profile (review C4)", async () => {
    const { mergeImportedEntries } = await import("./profileMerge");
    const { emptyMasterProfile } = await import("@/shared/schema");
    const { entries } = mapLinkedinRows(
      { skills: Array.from({ length: 65 }, (_, i) => ({ Name: `Skill ${i}` })) },
      deps,
    );
    const { profile, skipped } = mergeImportedEntries(
      emptyMasterProfile("Maya", "2026-07-12T00:00:00.000Z"),
      entries,
      "2026-07-12T00:00:00.000Z",
    );
    expect(profile.skills.flatMap((g) => g.items)).toHaveLength(65);
    expect(skipped).toBe(0); // nothing falsely reads as "already present"
  });

  it("sanitizeRows deletes exactly the pinned PII columns on every file kind (review C6)", async () => {
    const { sanitizeRows, LINKEDIN_PII_COLUMNS } = await import("./linkedinMapping");
    const dirty = Object.fromEntries(
      ["profile", "positions", "education"].map((kind) => [
        kind,
        [
          {
            Kept: "value",
            ...Object.fromEntries(LINKEDIN_PII_COLUMNS.map((column) => [column, "secret"])),
          },
        ],
      ]),
    );
    const clean = sanitizeRows(dirty as LinkedinRows);
    for (const rows of Object.values(clean)) {
      expect(rows[0]).toEqual({ Kept: "value" });
    }
  });
});
