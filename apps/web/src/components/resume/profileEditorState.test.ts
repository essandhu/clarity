import { describe, expect, it } from "vitest";
import { emptyMasterProfile, type MasterProfile } from "@/shared/schema";
import {
  addBullet,
  addEntry,
  fieldErrors,
  isDirty,
  moveEntry,
  parseCsvList,
  patchBullet,
  patchEntry,
  patchIdentity,
  removeBullet,
  removeEntry,
  snapshot,
} from "./profileEditorState";

const NOW = "2026-07-12T00:00:00.000Z";
let nextId = 0;
const mint = () => `id-${nextId++}`;

function base(): MasterProfile {
  return emptyMasterProfile("Maya Chen", NOW);
}

describe("profileEditorState", () => {
  it("addEntry appends a blank manual-provenance entry per section", () => {
    let profile = base();
    profile = addEntry(profile, "experience", mint, NOW);
    profile = addEntry(profile, "skills", mint, NOW);
    expect(profile.experience).toHaveLength(1);
    expect(profile.experience[0].provenance.origin).toBe("manual");
    expect(profile.skills).toHaveLength(1);
  });

  it("patchEntry updates only the targeted entry; removeEntry deletes it", () => {
    let profile = addEntry(addEntry(base(), "experience", mint, NOW), "experience", mint, NOW);
    const [first, second] = profile.experience;
    profile = patchEntry(profile, "experience", first.id, { org: "Driftlock" });
    expect(profile.experience[0].org).toBe("Driftlock");
    expect(profile.experience[1].org).toBe("");
    profile = removeEntry(profile, "experience", second.id);
    expect(profile.experience).toHaveLength(1);
  });

  it("moveEntry reorders and no-ops at the edges (order feeds the tailor prompt)", () => {
    let profile = base();
    for (let i = 0; i < 3; i++) profile = addEntry(profile, "education", mint, NOW);
    const ids = profile.education.map((e) => e.id);
    profile = moveEntry(profile, "education", ids[2], -1);
    expect(profile.education.map((e) => e.id)).toEqual([ids[0], ids[2], ids[1]]);
    const before = profile.education.map((e) => e.id);
    profile = moveEntry(profile, "education", before[0], -1); // already first
    expect(profile.education.map((e) => e.id)).toEqual(before);
  });

  it("bullet add/patch/remove target the right entry", () => {
    let profile = addEntry(base(), "projects", mint, NOW);
    const entryId = profile.projects[0].id;
    profile = addBullet(profile, "projects", entryId, mint);
    const bulletId = profile.projects[0].bullets[0].id;
    profile = patchBullet(profile, "projects", entryId, bulletId, "Renders a million points");
    expect(profile.projects[0].bullets[0].text).toBe("Renders a million points");
    profile = removeBullet(profile, "projects", entryId, bulletId);
    expect(profile.projects[0].bullets).toHaveLength(0);
  });

  it("fieldErrors names the failing field path with friendly copy (§6 contract)", () => {
    let profile = addEntry(base(), "experience", mint, NOW); // org/role blank
    profile = patchIdentity(profile, { name: "" });
    const errors = fieldErrors(profile);
    expect(errors["identity.name"]).toBe("required");
    expect(errors["experience.0.org"]).toBe("required");
    expect(errors["experience.0.role"]).toBe("required");
  });

  it("a valid profile has zero field errors", () => {
    expect(fieldErrors(base())).toEqual({});
  });

  it("isDirty flags any divergence from the baseline snapshot", () => {
    const profile = base();
    const baseline = snapshot(profile);
    expect(isDirty(profile, baseline)).toBe(false);
    expect(isDirty(patchIdentity(profile, { email: "maya@example.com" }), baseline)).toBe(true);
  });

  it("parseCsvList trims and drops empties WITHOUT capping — the zod max surfaces instead (F15)", () => {
    expect(parseCsvList(" Go, TypeScript,, Python ")).toEqual(["Go", "TypeScript", "Python"]);
    expect(parseCsvList("")).toEqual([]);
    const thirtyOne = Array.from({ length: 31 }, (_, i) => `item${i}`).join(", ");
    expect(parseCsvList(thirtyOne)).toHaveLength(31); // nothing silently destroyed
  });

  it("an over-cap skills list surfaces as a NAMED zod error instead of silent truncation (F15)", () => {
    let profile = addEntry(base(), "skills", mint, NOW);
    profile = patchEntry(profile, "skills", profile.skills[0].id, {
      category: "Languages",
      items: Array.from({ length: 31 }, (_, i) => `item${i}`),
    });
    const errors = fieldErrors(profile);
    expect(errors["skills.0.items"]).toBeTruthy(); // Save blocked, cap named
  });
});
