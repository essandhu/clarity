import type {
  ExperienceEntry,
  ListingProfile,
  MasterProfile,
  ProfileBullet,
  ProjectEntry,
  TailorCoverage,
  TailoredBullet,
  TailoredEntry,
  TailoredResume,
  TailorSelection,
} from "@/shared/schema";
import { checkRephrase, tokenizeWords } from "./rephraseGates";
import { joinDates, type AliasedEntry, type TailorAliasContext } from "./tailorPrompt";
import { resolveSkills, type DropSink } from "./skillsGate";

// The resolve fold (PLAN-RESUME.md §4.2): TailorSelection (model, alias ids)
// + MasterProfile (disk truth) -> TailoredResume + computed TailorCoverage.
// Every output string is verbatim master content, a gated rephrase, or a
// mechanical join; the model has no channel to claim coverage (decision 16).
// Resolved entries ride in SELECTION order — the model's relevance ranking
// IS the reorder feature decision 41 makes visible against master order.

/** TailoredResumeSchema.entries max — excess selections are counted
 *  over_cap, never a zod failure on the tailor.completed frame. */
export const MAX_RESOLVED_ENTRIES = 10;
const MAX_REPHRASE_CHARS = 400;
const MAX_DROP_SAMPLES = 10;
const SAMPLE_CLIP = 60;

export function normalizeWs(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Gate 3's grounding corpus for one bullet: the source bullet ∪ that
 *  entry's org/role/technologies — NEVER the role profile. Exported so the
 *  try-tailor driver can re-run the gates over the live wire. */
export function groundingCorpus(
  kind: "experience" | "project",
  entry: ExperienceEntry | ProjectEntry,
  bulletText: string,
): string[] {
  return kind === "experience"
    ? [bulletText, (entry as ExperienceEntry).org, (entry as ExperienceEntry).role]
    : [bulletText, (entry as ProjectEntry).name, ...(entry as ProjectEntry).technologies];
}

export interface ResolvedTailor {
  resume: TailoredResume;
  coverage: TailorCoverage;
}

export function resolveTailoredResume(
  selection: TailorSelection,
  master: MasterProfile,
  role: ListingProfile,
  ctx: TailorAliasContext,
  mode: TailorCoverage["mode"],
): ResolvedTailor {
  const drops = new Map<string, TailorCoverage["dropped"][number]>();
  const drop: DropSink = (kind, reason, sample) => {
    const key = `${kind}|${reason}`;
    const record = drops.get(key) ?? { kind, reason, count: 0, samples: [] };
    record.count += 1;
    const clipped = sample?.trim().slice(0, SAMPLE_CLIP);
    if (clipped && record.samples.length < MAX_DROP_SAMPLES && !record.samples.includes(clipped)) {
      record.samples.push(clipped);
    }
    drops.set(key, record);
  };

  const entries: TailoredEntry[] = [];
  const seenAliases = new Set<string>();
  for (const sel of selection.entries) {
    const aliased = ctx.aliases.get(sel.entryId);
    if (!aliased) {
      drop("entry", "unknown_id", sel.entryId);
      continue;
    }
    if (seenAliases.has(sel.entryId)) continue; // a restated selection, not a drop
    seenAliases.add(sel.entryId);
    if (entries.length >= MAX_RESOLVED_ENTRIES) {
      drop("entry", "over_cap", headingOf(aliased));
      continue;
    }
    entries.push(resolveEntry(sel, aliased, role, drop));
  }

  const skills = resolveSkills(selection.skills, master, drop);
  const resume: TailoredResume = {
    roleLabel: `${role.role} at ${role.company}`,
    identity: { ...master.identity, links: [...master.identity.links] },
    entries,
    education: [...master.education],
    skills,
  };
  const counts = countTailored(resume);
  return {
    resume,
    coverage: {
      mode,
      entriesTotal: ctx.entriesTotal,
      entriesOffered: ctx.entriesOffered,
      ...counts,
      dropped: [...drops.values()],
      keywords: roleKeywords(role, master),
    },
  };
}

function headingOf(aliased: AliasedEntry): string {
  return aliased.kind === "experience"
    ? (aliased.entry as ExperienceEntry).org
    : (aliased.entry as ProjectEntry).name;
}

/** Gate 6's model-free zones: heading/subheading/location/dates/url are
 *  copied verbatim from master (or mechanically joined) — the render never
 *  re-reads the store, so a later profile edit can't corrupt this document. */
function resolveEntry(
  sel: TailorSelection["entries"][number],
  aliased: AliasedEntry,
  role: ListingProfile,
  drop: DropSink,
): TailoredEntry {
  const rephraseByAlias = new Map((sel.rephrased ?? []).map((r) => [r.bulletId, r.text]));
  const bullets: TailoredBullet[] = [];
  const seenBullets = new Set<string>();
  for (const bulletAlias of sel.bulletIds) {
    if (seenBullets.has(bulletAlias)) continue;
    seenBullets.add(bulletAlias);
    const bullet = aliased.bullets.get(bulletAlias);
    if (!bullet) {
      drop("bullet", "unknown_id", bulletAlias);
      continue;
    }
    // A rephrased.bulletId outside the SELECTED bullets is ignored by
    // construction: only selected aliases are ever looked up here (§4.2.1).
    bullets.push(resolveBullet(bullet, rephraseByAlias.get(bulletAlias), aliased, role));
  }

  const entry = aliased.entry;
  const dates = joinDates(entry.startDate, entry.endDate);
  if (aliased.kind === "experience") {
    const exp = entry as ExperienceEntry;
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
  const project = entry as ProjectEntry;
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

/** Gates 2–4 over one bullet: revert, don't invent — visibly. Disposition is
 *  COMPUTED (whitespace-normalized comparison), never taken from the model. */
function resolveBullet(
  bullet: ProfileBullet,
  rephraseText: string | undefined,
  aliased: AliasedEntry,
  role: ListingProfile,
): TailoredBullet {
  const verbatim: TailoredBullet = {
    bulletId: bullet.id,
    text: bullet.text,
    disposition: "verbatim",
  };
  if (rephraseText === undefined) return verbatim;
  const candidate = rephraseText.trim();
  // An empty rephrase changed nothing visible — verbatim, not a revert.
  if (candidate.length === 0 || normalizeWs(candidate) === normalizeWs(bullet.text)) {
    return verbatim;
  }
  if (candidate.length > MAX_REPHRASE_CHARS) {
    return {
      bulletId: bullet.id,
      text: bullet.text,
      disposition: "reverted",
      offendingTokens: ["(rephrase over 400 characters)"],
    };
  }
  const verdict = checkRephrase({
    candidate,
    sourceBullet: bullet.text,
    corpus: groundingCorpus(aliased.kind, aliased.entry, bullet.text),
    roleTechnologies: role.namedTechnologies,
  });
  if (!verdict.ok) {
    return {
      bulletId: bullet.id,
      text: bullet.text,
      disposition: "reverted",
      offendingTokens: verdict.offendingTokens,
    };
  }
  return { bulletId: bullet.id, text: candidate, disposition: "rephrased" };
}

/** The counting half of coverage, exported alone so the client-side toggle
 *  fold (resumeToggles.ts) re-derives counts with the SAME arithmetic. */
export function countTailored(
  resume: TailoredResume,
): Pick<
  TailorCoverage,
  "entriesSelected" | "bulletsSelected" | "bulletsRephrased" | "bulletsReverted"
> {
  const bullets = resume.entries.flatMap((entry) => entry.bullets);
  return {
    entriesSelected: resume.entries.length,
    bulletsSelected: bullets.length,
    bulletsRephrased: bullets.filter((b) => b.disposition === "rephrased").length,
    bulletsReverted: bullets.filter((b) => b.disposition === "reverted").length,
  };
}

/** Decision 57: the role↔profile keyword gap, display-only by construction.
 *  A role technology counts as matched when it (or all of its word tokens)
 *  appears among master skill items ∪ project technologies. */
export function roleKeywords(
  role: ListingProfile,
  master: MasterProfile,
): TailorCoverage["keywords"] {
  const pool = new Set<string>();
  const addToPool = (value: string) => {
    const lower = value.trim().toLowerCase();
    if (lower.length === 0) return;
    pool.add(lower);
    for (const token of tokenizeWords(lower)) pool.add(token);
  };
  for (const group of master.skills) group.items.forEach(addToPool);
  for (const project of master.projects) project.technologies.forEach(addToPool);

  const matched: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const tech of role.namedTechnologies) {
    const display = tech.trim().slice(0, SAMPLE_CLIP);
    const lower = display.toLowerCase();
    if (display.length === 0 || seen.has(lower)) continue;
    seen.add(lower);
    const tokens = tokenizeWords(lower);
    const hit =
      pool.has(lower) || (tokens.length > 0 && tokens.every((token) => pool.has(token)));
    (hit ? matched : missing).push(display);
  }
  return { matched, missing };
}
