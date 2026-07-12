import {
  emptyMasterProfile,
  MasterProfileSchema,
  type EducationEntry,
  type ExperienceEntry,
  type MasterProfile,
  type ProjectEntry,
  type SkillGroup,
} from "@/shared/schema";

// Pure editor-state transitions for the master-profile editor (the
// runState/runReducer split applied here): every mutation the UI can make is
// an exported pure function over MasterProfile, so the §6 editor contract is
// unit-testable without a DOM rig. Components stay thin.

export type EntrySection = "experience" | "projects" | "education" | "skills";

/** crypto.randomUUID needs a secure context (the HookCard clipboard lesson);
 *  a LAN-http visitor still gets working ids. */
export function mintClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function blankProfile(nowIso: string): MasterProfile {
  return emptyMasterProfile("", nowIso); // name blank ⇒ Save blocked, field named
}

type AnyEntry = ExperienceEntry | ProjectEntry | EducationEntry | SkillGroup;

export function addEntry(
  profile: MasterProfile,
  section: EntrySection,
  mintId: () => string,
  nowIso: string,
): MasterProfile {
  const provenance = { origin: "manual" as const, importedAt: nowIso };
  switch (section) {
    case "experience":
      return {
        ...profile,
        experience: [...profile.experience, { id: mintId(), org: "", role: "", bullets: [], provenance }],
      };
    case "projects":
      return {
        ...profile,
        projects: [
          ...profile.projects,
          { id: mintId(), name: "", technologies: [], bullets: [], provenance },
        ],
      };
    case "education":
      return {
        ...profile,
        education: [...profile.education, { id: mintId(), school: "", provenance }],
      };
    case "skills":
      return { ...profile, skills: [...profile.skills, { id: mintId(), category: "", items: [] }] };
    default:
      return section satisfies never;
  }
}

export function patchEntry(
  profile: MasterProfile,
  section: EntrySection,
  id: string,
  patch: Record<string, unknown>,
): MasterProfile {
  const list = (profile[section] as AnyEntry[]).map((entry) =>
    entry.id === id ? ({ ...entry, ...patch } as AnyEntry) : entry,
  );
  return { ...profile, [section]: list };
}

export function removeEntry(
  profile: MasterProfile,
  section: EntrySection,
  id: string,
): MasterProfile {
  return {
    ...profile,
    [section]: (profile[section] as AnyEntry[]).filter((entry) => entry.id !== id),
  };
}

/** Order is meaningful (most-recent-first feeds the tailor prompt cap and
 *  the fallback selection) — up/down buttons, no drag dependency. */
export function moveEntry(
  profile: MasterProfile,
  section: EntrySection,
  id: string,
  delta: -1 | 1,
): MasterProfile {
  const list = [...(profile[section] as AnyEntry[])];
  const from = list.findIndex((entry) => entry.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return profile;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return { ...profile, [section]: list };
}

export function addBullet(
  profile: MasterProfile,
  section: "experience" | "projects",
  entryId: string,
  mintId: () => string,
): MasterProfile {
  const list = profile[section].map((entry) =>
    entry.id === entryId
      ? { ...entry, bullets: [...entry.bullets, { id: mintId(), text: "" }] }
      : entry,
  );
  return { ...profile, [section]: list } as MasterProfile;
}

export function patchBullet(
  profile: MasterProfile,
  section: "experience" | "projects",
  entryId: string,
  bulletId: string,
  text: string,
): MasterProfile {
  const list = profile[section].map((entry) =>
    entry.id === entryId
      ? {
          ...entry,
          bullets: entry.bullets.map((bullet) =>
            bullet.id === bulletId ? { ...bullet, text } : bullet,
          ),
        }
      : entry,
  );
  return { ...profile, [section]: list } as MasterProfile;
}

export function removeBullet(
  profile: MasterProfile,
  section: "experience" | "projects",
  entryId: string,
  bulletId: string,
): MasterProfile {
  const list = profile[section].map((entry) =>
    entry.id === entryId
      ? { ...entry, bullets: entry.bullets.filter((bullet) => bullet.id !== bulletId) }
      : entry,
  );
  return { ...profile, [section]: list } as MasterProfile;
}

export function patchIdentity(
  profile: MasterProfile,
  patch: Partial<MasterProfile["identity"]>,
): MasterProfile {
  return { ...profile, identity: { ...profile.identity, ...patch } };
}

/** Per-field validation copy from the zod issues (§6: "role — required",
 *  shown on blur and on Save; an invalid card blocks Save with the field
 *  named). Keys are dotted issue paths ("experience.0.org"). */
export function fieldErrors(profile: MasterProfile): Record<string, string> {
  const parsed = MasterProfileSchema.safeParse(profile);
  if (parsed.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".");
    if (!(key in errors)) errors[key] = friendlyIssue(issue.message);
  }
  return errors;
}

function friendlyIssue(message: string): string {
  if (/too small|at least 1|expected string.*received undefined/i.test(message)) return "required";
  return message;
}

/** The dirty state IS the undo boundary (§6): any divergence from the last
 *  loaded/saved snapshot enables Save; a reload discards unsaved edits. */
export function isDirty(draft: MasterProfile, baseline: string): boolean {
  return JSON.stringify(draft) !== baseline;
}

export function snapshot(profile: MasterProfile): string {
  return JSON.stringify(profile);
}

/** "a, b, c" ⇄ ["a","b","c"] for the technologies / skill-items inputs.
 *  Deliberately UNCAPPED: truncating here would destroy user-typed items
 *  silently on blur — the zod max fires instead and its validation copy
 *  names the cap, blocking Save honestly (review F15). */
export function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
