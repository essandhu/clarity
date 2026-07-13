import type { MasterProfile, SkillGroup, TailorCoverage, TailorSelection } from "@/shared/schema";

// Gate 5 (PLAN-RESUME.md §4.2): skills are strict case-insensitive
// set-subsets of master skill items ∪ project technologies, and categories
// must match a master category — a model-invented label reverts to the
// master group its surviving items came from, so a hostile role cannot
// smuggle a competence claim through a bold section label. Pre-split from
// tailorGrounding.ts under the ~200-line ceiling.

/** SkillGroupSchema.items max — a technologies-union overflow is clipped
 *  with a named over_cap drop, never a zod failure on the wire. */
const MAX_GROUP_ITEMS = 30;

export type DropSink = (
  kind: TailorCoverage["dropped"][number]["kind"],
  reason: TailorCoverage["dropped"][number]["reason"],
  sample?: string,
) => void;

export function resolveSkills(
  selected: TailorSelection["skills"],
  master: MasterProfile,
  drop: DropSink,
): SkillGroup[] {
  // lowercased item -> canonical master casing; the resolved resume carries
  // the MASTER string, never the model's echo of it.
  const itemPool = new Map<string, string>();
  // lowercased item -> the first master group carrying it (the revert home).
  const itemHome = new Map<string, SkillGroup>();
  for (const group of master.skills) {
    for (const item of group.items) {
      const key = item.trim().toLowerCase();
      if (!itemPool.has(key)) itemPool.set(key, item);
      if (!itemHome.has(key)) itemHome.set(key, group);
    }
  }
  for (const project of master.projects) {
    for (const tech of project.technologies) {
      const key = tech.trim().toLowerCase();
      if (key.length > 0 && !itemPool.has(key)) itemPool.set(key, tech);
    }
  }
  const groupByCategory = new Map(
    master.skills.map((group) => [group.category.trim().toLowerCase(), group]),
  );

  // Selected groups resolving to the same master group merge (one id, one
  // React key, one resume section line).
  const resolved = new Map<string, { group: SkillGroup; items: string[] }>();
  for (const sel of selected) {
    const survivors: string[] = [];
    const contributions = new Map<string, number>();
    for (const item of sel.items) {
      const key = item.trim().toLowerCase();
      const canonical = itemPool.get(key);
      if (canonical === undefined) {
        drop("skill", "not_subset", item);
        continue;
      }
      if (survivors.some((s) => s.toLowerCase() === canonical.toLowerCase())) continue;
      survivors.push(canonical);
      const home = itemHome.get(key);
      if (home) contributions.set(home.id, (contributions.get(home.id) ?? 0) + 1);
    }
    if (survivors.length === 0) continue; // every miss already counted

    let home = groupByCategory.get(sel.category.trim().toLowerCase());
    if (!home) {
      drop("skill", "not_subset", sel.category);
      home = revertHome(master, contributions);
      if (!home) {
        // Invented category AND only technology-sourced items: no master
        // group to revert to — the group drops whole, each orphan named
        // (a corner reachable only through a hostile category).
        for (const item of survivors) drop("skill", "not_subset", item);
        continue;
      }
    }
    const record = resolved.get(home.id) ?? { group: home, items: [] };
    for (const item of survivors) {
      if (!record.items.some((s) => s.toLowerCase() === item.toLowerCase())) {
        record.items.push(item);
      }
    }
    resolved.set(home.id, record);
  }

  return [...resolved.values()].map(({ group, items }) => {
    for (const overflow of items.slice(MAX_GROUP_ITEMS)) {
      drop("skill", "over_cap", overflow);
    }
    return { id: group.id, category: group.category, items: items.slice(0, MAX_GROUP_ITEMS) };
  });
}

/** The master group that contributed the most surviving items; ties break to
 *  master order — the fold has exactly one answer (§4.2 gate 5). */
function revertHome(
  master: MasterProfile,
  contributions: Map<string, number>,
): SkillGroup | undefined {
  let best: SkillGroup | undefined;
  let bestCount = 0;
  for (const group of master.skills) {
    const count = contributions.get(group.id) ?? 0;
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best;
}
