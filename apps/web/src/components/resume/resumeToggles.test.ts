import { describe, expect, it } from "vitest";
import { resolveTailoredResume } from "@/domain/resume/tailorGrounding";
import { makeExperience, makeMaster, makeRole } from "@/domain/resume/tailorTestKit";
import { tailorSelectionPrompt } from "@/domain/resume/tailorPrompt";
import type { TailorSelection } from "@/shared/schema";
import { applyResumeToggles, emptyToggles, entryMoves } from "./resumeToggles";

// The zero-model toggle fold (decision 41): exclusion, verbatim re-inclusion
// at master order, named cap rejections, and coverage counts re-derived by
// the same counting fold — all against a CANONICAL resume produced by the
// real resolve fold.

const master = makeMaster();
const role = makeRole();
const ctx = tailorSelectionPrompt(master, role).ctx;

function canonical(selection: TailorSelection) {
  return resolveTailoredResume(selection, master, role, ctx, "tailored");
}

// The model selected e1 (2 bullets) + p1; skipped e2 and e1's third bullet.
const base = canonical({
  entries: [
    { entryId: "e1", bulletIds: ["e1b1", "e1b2"] },
    { entryId: "p1", bulletIds: ["p1b1"] },
  ],
  skills: [{ category: "Languages", items: ["Go"] }],
});

describe("applyResumeToggles", () => {
  it("no toggles: the canonical resume and counts pass through", () => {
    const { resume, coverage, rejected } = applyResumeToggles(
      base.resume,
      base.coverage,
      master,
      emptyToggles,
    );
    expect(resume).toEqual(base.resume);
    expect(coverage).toEqual(base.coverage);
    expect(rejected).toEqual({ entryIds: [], bulletIds: [] });
  });

  it("excluding an entry removes it and the counts follow", () => {
    const { resume, coverage } = applyResumeToggles(base.resume, base.coverage, master, {
      ...emptyToggles,
      excludedEntryIds: ["proj-driftviz"],
    });
    expect(resume.entries.map((e) => e.entryId)).toEqual(["exp-driftlock"]);
    expect(coverage.entriesSelected).toBe(1);
    expect(coverage.bulletsSelected).toBe(2);
  });

  it("excluding a bullet removes just that bullet", () => {
    const { resume, coverage } = applyResumeToggles(base.resume, base.coverage, master, {
      ...emptyToggles,
      excludedBulletIds: ["b-ingest"],
    });
    expect(resume.entries[0].bullets.map((b) => b.bulletId)).toEqual(["b-migration"]);
    expect(coverage.bulletsSelected).toBe(2);
  });

  it("re-includes a model-skipped entry VERBATIM at master order", () => {
    const { resume } = applyResumeToggles(base.resume, base.coverage, master, {
      ...emptyToggles,
      reincluded: ["exp-acme"],
    });
    // exp-acme sits after exp-driftlock in master order, before the project.
    expect(resume.entries.map((e) => e.entryId)).toEqual([
      "exp-driftlock",
      "exp-acme",
      "proj-driftviz",
    ]);
    const acme = resume.entries[1];
    expect(acme.heading).toBe("Acme Analytics");
    expect(acme.bullets.every((b) => b.disposition === "verbatim")).toBe(true);
    expect(acme.bullets.map((b) => b.text)).toEqual(
      master.experience[1].bullets.map((b) => b.text),
    );
  });

  it("re-includes a model-skipped bullet at master bullet order", () => {
    const { resume } = applyResumeToggles(base.resume, base.coverage, master, {
      ...emptyToggles,
      reincluded: ["b-mentoring"],
    });
    expect(resume.entries[0].bullets.map((b) => b.bulletId)).toEqual([
      "b-ingest",
      "b-migration",
      "b-mentoring",
    ]);
    expect(resume.entries[0].bullets[2].disposition).toBe("verbatim");
  });

  it("names re-inclusions the schema caps refuse — never silent", () => {
    const wide = makeMaster({
      experience: Array.from({ length: 12 }, (_, i) =>
        makeExperience({
          id: `exp-${i}`,
          org: `Org ${i}`,
          bullets: Array.from({ length: 8 }, (_, bi) => ({
            id: `b-${i}-${bi}`,
            text: `Bullet ${bi} of org ${i}`,
          })),
        }),
      ),
      projects: [],
    });
    const wideCtx = tailorSelectionPrompt(wide, role).ctx;
    const full = resolveTailoredResume(
      {
        entries: Array.from({ length: 10 }, (_, i) => ({
          entryId: `e${i + 1}`,
          bulletIds: [`e${i + 1}b1`, `e${i + 1}b2`, `e${i + 1}b3`, `e${i + 1}b4`, `e${i + 1}b5`, `e${i + 1}b6`],
        })),
        skills: [],
      },
      wide,
      role,
      wideCtx,
      "tailored",
    );
    const { resume, rejected } = applyResumeToggles(full.resume, full.coverage, wide, {
      ...emptyToggles,
      // an 11th entry (10-entry cap) and a 7th bullet on a full entry:
      reincluded: ["exp-10", "b-0-6"],
    });
    expect(resume.entries).toHaveLength(10);
    expect(rejected.entryIds).toEqual(["exp-10"]);
    expect(rejected.bulletIds).toEqual(["b-0-6"]);
  });

  it("exclusion wins over a stale re-inclusion of the same id", () => {
    const { resume } = applyResumeToggles(base.resume, base.coverage, master, {
      excludedEntryIds: ["exp-acme"],
      excludedBulletIds: [],
      reincluded: ["exp-acme"],
    });
    expect(resume.entries.some((e) => e.entryId === "exp-acme")).toBe(false);
  });
});

describe("entryMoves — reorder badges vs master order", () => {
  it("a model reorder shows up/down; pure exclusion shows nothing", () => {
    const reordered = canonical({
      entries: [
        { entryId: "e2", bulletIds: ["e2b1"] },
        { entryId: "e1", bulletIds: ["e1b1"] },
      ],
      skills: [],
    });
    expect(entryMoves(reordered.resume, master)).toEqual({
      "exp-acme": "up",
      "exp-driftlock": "down",
    });

    const excludedOnly = canonical({
      entries: [{ entryId: "e2", bulletIds: ["e2b1"] }],
      skills: [],
    });
    expect(entryMoves(excludedOnly.resume, master)).toEqual({});
  });
});
