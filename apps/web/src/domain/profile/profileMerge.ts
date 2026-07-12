import type { ImportedEntries, MasterProfile, SkillGroup } from "@/shared/schema";
import { normalizeForMatch } from "./resumeImportGrounding";

// Merge imported entries into the editor's draft profile (decision 42:
// imports land UNSAVED; only an explicit PUT persists). Pure — the client
// calls this and the user reviews before saving. Duplicate suppression keys
// (§4.5): experience by org+role+dates, projects by name, education by
// school+degree; skills merge item-wise into a same-category group.

export interface MergeResult {
  profile: MasterProfile;
  added: number;
  skipped: number;
}

export function mergeImportedEntries(
  profile: MasterProfile,
  imported: ImportedEntries,
  updatedAt: string,
): MergeResult {
  let added = 0;
  let skipped = 0;

  const dedupInto = <T>(existing: T[], incoming: T[], max: number, keyOf: (item: T) => string) => {
    const seen = new Set(existing.map(keyOf));
    const out = [...existing];
    for (const item of incoming) {
      const key = keyOf(item);
      if (seen.has(key) || out.length >= max) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      out.push(item);
      added += 1;
    }
    return out;
  };

  // Each field is normalized SEPARATELY before joining: normalizing the
  // joined string would keep a stray space beside the separator distinct
  // ("driftlock |engineer" vs "driftlock|engineer").
  const fieldKey = (...fields: (string | undefined)[]) =>
    fields.map((field) => normalizeForMatch(field ?? "")).join("|");
  const experience = dedupInto(profile.experience, imported.experience, 30, (e) =>
    fieldKey(e.org, e.role, e.startDate, e.endDate),
  );
  const education = dedupInto(profile.education, imported.education, 10, (e) =>
    fieldKey(e.school, e.degree),
  );
  const projects = dedupInto(profile.projects, imported.projects, 30, (p) =>
    normalizeForMatch(p.name),
  );

  // Skills: union items into an existing group with the same category; new
  // categories append as whole groups (respecting the 10-group cap).
  let skills: SkillGroup[] = profile.skills.map((group) => ({ ...group, items: [...group.items] }));
  for (const group of imported.skills) {
    const target = skills.find(
      (candidate) => normalizeForMatch(candidate.category) === normalizeForMatch(group.category),
    );
    if (target) {
      const seen = new Set(target.items.map(normalizeForMatch));
      for (const item of group.items) {
        if (seen.has(normalizeForMatch(item)) || target.items.length >= 30) {
          skipped += 1;
          continue;
        }
        seen.add(normalizeForMatch(item));
        target.items.push(item);
        added += 1;
      }
    } else if (skills.length < 10) {
      // Copied, never aliased: two imported groups can share a category (the
      // grounding fallback mints duplicate "Skills" headings), and pushing
      // into an aliased group would mutate the caller's ImportedEntries —
      // React StrictMode double-invokes the setDraft updater and would see
      // the mutation (review F4).
      skills = [...skills, { ...group, items: [...group.items] }];
      added += 1;
    } else {
      skipped += 1;
    }
  }

  // A merge that added nothing changed nothing: returning the SAME profile
  // (untouched updatedAt) keeps the dirty indicator honest — a machine-
  // minted timestamp must not read as "unsaved changes" (review F12).
  if (added === 0) return { profile, added, skipped };
  return {
    profile: { ...profile, experience, projects, education, skills, updatedAt },
    added,
    skipped,
  };
}
