import { describe, expect, it } from "vitest";
import { fallbackSelection } from "./fallbackSelection";
import { resolveTailoredResume } from "./tailorGrounding";
import { makeExperience, makeMaster, makeProject, makeRole } from "./tailorTestKit";
import { tailorSelectionPrompt } from "./tailorPrompt";

// Decision 40's pinned constants: 3 most-recent experience × first 2 bullets,
// 2 projects by pushedAt when present else master order, all skill groups
// (clamped to the resolved schema's 6), no rephrased — pure and model-free.

const role = makeRole();

function github(pushedAt: string) {
  return { fullName: "mayachen/x", stars: 1, pushedAt, languages: { TypeScript: 100 } };
}

const bullets = (prefix: string) => [
  { id: `${prefix}-1`, text: `${prefix} first bullet` },
  { id: `${prefix}-2`, text: `${prefix} second bullet` },
  { id: `${prefix}-3`, text: `${prefix} third bullet` },
];

describe("fallbackSelection", () => {
  it("picks the 3 most-recent experience entries × their first 2 bullets, no rephrased", () => {
    const master = makeMaster({
      experience: Array.from({ length: 4 }, (_, i) =>
        makeExperience({ id: `exp-${i}`, org: `Org ${i}`, bullets: bullets(`b${i}`) }),
      ),
      projects: [],
    });
    const ctx = tailorSelectionPrompt(master, role).ctx;
    const selection = fallbackSelection(master, ctx);
    expect(selection.entries.map((e) => e.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(selection.entries[0].bulletIds).toEqual(["e1b1", "e1b2"]);
    expect(selection.entries.every((e) => e.rephrased === undefined)).toBe(true);
  });

  it("orders the 2 projects by pushedAt when EVERY project carries one", () => {
    const master = makeMaster({
      experience: [],
      projects: [
        makeProject({ id: "proj-a", name: "alpha", github: github("2026-01-01T00:00:00.000Z") }),
        makeProject({ id: "proj-b", name: "beta", github: github("2026-06-01T00:00:00.000Z") }),
        makeProject({ id: "proj-c", name: "gamma", github: github("2025-12-01T00:00:00.000Z") }),
      ],
    });
    const ctx = tailorSelectionPrompt(master, role).ctx;
    // beta (most recently pushed) then alpha — p2 before p1.
    expect(fallbackSelection(master, ctx).entries.map((e) => e.entryId)).toEqual(["p2", "p1"]);
  });

  it("any missing sort key ⇒ master order", () => {
    const master = makeMaster({
      experience: [],
      projects: [
        makeProject({ id: "proj-a", name: "alpha" }), // no github.pushedAt
        makeProject({ id: "proj-b", name: "beta", github: github("2026-06-01T00:00:00.000Z") }),
        makeProject({ id: "proj-c", name: "gamma", github: github("2025-12-01T00:00:00.000Z") }),
      ],
    });
    const ctx = tailorSelectionPrompt(master, role).ctx;
    expect(fallbackSelection(master, ctx).entries.map((e) => e.entryId)).toEqual(["p1", "p2"]);
  });

  it("takes all skill groups, clamped to the resolved schema's 6", () => {
    const master = makeMaster({
      skills: Array.from({ length: 8 }, (_, i) => ({
        id: `sk-${i}`,
        category: `Group ${i}`,
        items: [`Item ${i}`],
      })),
    });
    const ctx = tailorSelectionPrompt(master, role).ctx;
    const selection = fallbackSelection(master, ctx);
    expect(selection.skills).toHaveLength(6);
    expect(selection.skills[0]).toEqual({ category: "Group 0", items: ["Item 0"] });
  });

  it("resolves through the real fold with zero drops, all-verbatim", () => {
    const master = makeMaster();
    const ctx = tailorSelectionPrompt(master, role).ctx;
    const { resume, coverage } = resolveTailoredResume(
      fallbackSelection(master, ctx),
      master,
      role,
      ctx,
      "fallback-untailored",
    );
    expect(coverage.mode).toBe("fallback-untailored");
    expect(coverage.dropped).toHaveLength(0);
    expect(coverage.bulletsRephrased).toBe(0);
    expect(coverage.bulletsReverted).toBe(0);
    expect(resume.entries.map((e) => e.entryId)).toEqual([
      "exp-driftlock",
      "exp-acme",
      "proj-driftviz",
    ]);
    expect(
      resume.entries.flatMap((e) => e.bullets).every((b) => b.disposition === "verbatim"),
    ).toBe(true);
  });
});
