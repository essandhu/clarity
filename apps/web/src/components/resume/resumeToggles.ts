import { countTailored } from "@/domain/resume/tailorGrounding";
import { joinDates } from "@/domain/resume/tailorPrompt";
import type {
  ExperienceEntry,
  MasterProfile,
  ProfileBullet,
  ProjectEntry,
  TailorCoverage,
  TailoredBullet,
  TailoredEntry,
  TailoredResume,
} from "@/shared/schema";

// Post-run toggles (decision 41): entry/bullet exclusion + re-inclusion of
// master content the model skipped, with ZERO model calls — a pure re-fold
// over the canonical resume. Re-included content is VERBATIM master text
// inserted at master order; coverage counts are re-derived by the same
// counting fold so the CoveragePanel stays truthful after edits. Schema caps
// (10 entries, 6 bullets) are enforced with NAMED rejections, never silently.

export interface ResumeToggles {
  excludedEntryIds: string[];
  excludedBulletIds: string[];
  /** Master entry ids AND bullet ids the model skipped that the user added
   *  back (ids are UUIDs — one namespace, no collisions). */
  reincluded: string[];
}

export const emptyToggles: ResumeToggles = {
  excludedEntryIds: [],
  excludedBulletIds: [],
  reincluded: [],
};

export interface ToggledResume {
  resume: TailoredResume;
  coverage: TailorCoverage;
  /** Re-inclusions the schema caps refused — surfaced, never silent. */
  rejected: { entryIds: string[]; bulletIds: string[] };
}

/**
 * The ONE checkbox transition (review F8): including an id must both clear
 * its exclusion AND — when the canonical resume never carried it — restore
 * its re-inclusion, or the third click on model-skipped content is a silent
 * dead click (tick → untick → tick). Excluding removes any re-inclusion so
 * the two lists can never both claim an id.
 */
export function toggleId(
  toggles: ResumeToggles,
  kind: "entry" | "bullet",
  id: string,
  present: boolean,
  inCanonical: boolean,
): ResumeToggles {
  const listKey = kind === "entry" ? "excludedEntryIds" : "excludedBulletIds";
  if (present) {
    return { ...toggles, [listKey]: add(toggles[listKey], id), reincluded: remove(toggles.reincluded, id) };
  }
  return {
    ...toggles,
    [listKey]: remove(toggles[listKey], id),
    reincluded: inCanonical ? remove(toggles.reincluded, id) : add(toggles.reincluded, id),
  };
}

function add(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

function remove(list: string[], id: string): string[] {
  return list.filter((x) => x !== id);
}

const MAX_ENTRIES = 10;
const MAX_BULLETS = 6;

type MasterEntry =
  | { kind: "experience"; index: number; entry: ExperienceEntry }
  | { kind: "project"; index: number; entry: ProjectEntry };

export function applyResumeToggles(
  canonical: TailoredResume,
  coverage: TailorCoverage,
  master: MasterProfile,
  toggles: ResumeToggles,
): ToggledResume {
  const excludedEntries = new Set(toggles.excludedEntryIds);
  const excludedBullets = new Set(toggles.excludedBulletIds);
  const rejected = { entryIds: [] as string[], bulletIds: [] as string[] };
  const masterIndex = indexMaster(master);

  let entries = canonical.entries
    .filter((entry) => !excludedEntries.has(entry.entryId))
    .map((entry) => ({
      ...entry,
      bullets: entry.bullets.filter((bullet) => !excludedBullets.has(bullet.bulletId)),
    }));

  for (const id of toggles.reincluded) {
    if (excludedEntries.has(id) || excludedBullets.has(id)) continue; // exclusion wins
    const masterEntry = masterIndex.entries.get(id);
    if (masterEntry) {
      if (entries.some((entry) => entry.entryId === id)) continue;
      if (entries.length >= MAX_ENTRIES) {
        rejected.entryIds.push(id);
        continue;
      }
      entries = insertAtMasterOrder(
        entries,
        buildVerbatimEntry(masterEntry, excludedBullets, rejected),
        masterEntry,
        masterIndex,
      );
      continue;
    }
    const home = masterIndex.bulletHomes.get(id);
    if (!home) continue; // not a master id — corrupt toggle state is inert
    const target = entries.find((entry) => entry.entryId === home.entryId);
    if (!target || target.bullets.some((bullet) => bullet.bulletId === id)) continue;
    if (target.bullets.length >= MAX_BULLETS) {
      rejected.bulletIds.push(id);
      continue;
    }
    target.bullets = insertBulletAtMasterOrder(target.bullets, home, masterIndex);
  }

  const resume: TailoredResume = { ...canonical, entries };
  return {
    resume,
    coverage: { ...coverage, ...countTailored(resume) },
    // Deduped (review F13): an overflow bullet the user ALSO ticked must not
    // inflate the refusal copy by counting twice.
    rejected: {
      entryIds: [...new Set(rejected.entryIds)],
      bulletIds: [...new Set(rejected.bulletIds)],
    },
  };
}

/** Moved-up/moved-down badges vs master array order (decision 41), computed
 *  per kind over the INCLUDED set: pure exclusion shifts no ranks, so badges
 *  appear only when the model (or the user) actually reordered. */
export function entryMoves(
  resume: TailoredResume,
  master: MasterProfile,
): Record<string, "up" | "down" | undefined> {
  const masterIndex = indexMaster(master);
  const moves: Record<string, "up" | "down" | undefined> = {};
  for (const kind of ["experience", "project"] as const) {
    const included = resume.entries.filter((entry) => entry.kind === kind);
    const ranks = included
      .map((entry) => masterIndex.entries.get(entry.entryId)?.index ?? 0)
      .sort((a, b) => a - b);
    included.forEach((entry, position) => {
      const rank = ranks.indexOf(masterIndex.entries.get(entry.entryId)?.index ?? 0);
      if (position < rank) moves[entry.entryId] = "up";
      else if (position > rank) moves[entry.entryId] = "down";
    });
  }
  return moves;
}

interface MasterIndex {
  entries: Map<string, MasterEntry>;
  bulletHomes: Map<string, { entryId: string; bullet: ProfileBullet; index: number }>;
}

function indexMaster(master: MasterProfile): MasterIndex {
  const entries = new Map<string, MasterEntry>();
  const bulletHomes = new Map<string, { entryId: string; bullet: ProfileBullet; index: number }>();
  master.experience.forEach((entry, index) => {
    entries.set(entry.id, { kind: "experience", index, entry });
    entry.bullets.forEach((bullet, bulletIndex) =>
      bulletHomes.set(bullet.id, { entryId: entry.id, bullet, index: bulletIndex }),
    );
  });
  master.projects.forEach((entry, index) => {
    entries.set(entry.id, { kind: "project", index, entry });
    entry.bullets.forEach((bullet, bulletIndex) =>
      bulletHomes.set(bullet.id, { entryId: entry.id, bullet, index: bulletIndex }),
    );
  });
  return { entries, bulletHomes };
}

/** Verbatim master entry — the same gate-6 mechanical joins the fold uses,
 *  with every bullet disposition 'verbatim'. Overflow past the 6-bullet
 *  schema cap is NAMED in rejected.bulletIds. */
function buildVerbatimEntry(
  masterEntry: MasterEntry,
  excludedBullets: Set<string>,
  rejected: { bulletIds: string[] },
): TailoredEntry {
  const { entry } = masterEntry;
  const kept = entry.bullets.filter((bullet) => !excludedBullets.has(bullet.id));
  for (const overflow of kept.slice(MAX_BULLETS)) rejected.bulletIds.push(overflow.id);
  const bullets: TailoredBullet[] = kept
    .slice(0, MAX_BULLETS)
    .map((bullet) => ({ bulletId: bullet.id, text: bullet.text, disposition: "verbatim" }));
  const dates = joinDates(entry.startDate, entry.endDate);
  if (masterEntry.kind === "experience") {
    const exp = masterEntry.entry;
    return {
      entryId: exp.id,
      kind: "experience",
      heading: exp.org,
      subheading: exp.role,
      ...(exp.location !== undefined ? { location: exp.location } : {}),
      ...(dates !== undefined ? { dates } : {}),
      bullets,
    };
  }
  const project = masterEntry.entry;
  return {
    entryId: project.id,
    kind: "project",
    heading: project.name,
    ...(project.technologies.length > 0
      ? { subheading: project.technologies.join(", ") }
      : {}),
    ...(dates !== undefined ? { dates } : {}),
    ...(project.url !== undefined ? { url: project.url } : {}),
    bullets,
  };
}

function insertAtMasterOrder(
  entries: TailoredEntry[],
  entry: TailoredEntry,
  masterEntry: MasterEntry,
  masterIndex: MasterIndex,
): TailoredEntry[] {
  // Before the first SAME-KIND entry that sits later in master order; else
  // after the last same-kind entry; else at the end.
  const at = entries.findIndex(
    (candidate) =>
      candidate.kind === entry.kind &&
      (masterIndex.entries.get(candidate.entryId)?.index ?? Number.MAX_SAFE_INTEGER) >
        masterEntry.index,
  );
  if (at >= 0) return [...entries.slice(0, at), entry, ...entries.slice(at)];
  const lastSameKind = entries.map((e) => e.kind).lastIndexOf(entry.kind);
  const insertAt = lastSameKind >= 0 ? lastSameKind + 1 : entries.length;
  return [...entries.slice(0, insertAt), entry, ...entries.slice(insertAt)];
}

function insertBulletAtMasterOrder(
  bullets: TailoredBullet[],
  home: { entryId: string; bullet: ProfileBullet; index: number },
  masterIndex: MasterIndex,
): TailoredBullet[] {
  const added: TailoredBullet = {
    bulletId: home.bullet.id,
    text: home.bullet.text,
    disposition: "verbatim",
  };
  const at = bullets.findIndex(
    (bullet) =>
      (masterIndex.bulletHomes.get(bullet.bulletId)?.index ?? Number.MAX_SAFE_INTEGER) >
      home.index,
  );
  return at >= 0
    ? [...bullets.slice(0, at), added, ...bullets.slice(at)]
    : [...bullets, added];
}
