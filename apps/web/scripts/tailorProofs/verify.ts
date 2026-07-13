// The §7.13 client-side re-verification suite: the driver re-runs the SAME
// pure gates the server used over the live wire, so server and client can
// independently agree on every grounding decision (the try-import verbatim
// precedent). Pre-split under the script-size convention.
import { checkRephrase } from "../../src/domain/resume/rephraseGates";
import {
  countTailored,
  groundingCorpus,
  normalizeWs,
} from "../../src/domain/resume/tailorGrounding";
import { joinDates } from "../../src/domain/resume/tailorPrompt";
import type {
  ExperienceEntry,
  ListingProfile,
  MasterProfile,
  ProjectEntry,
  TailorCoverage,
  TailoredResume,
} from "../../src/shared/schema";
import { check } from "../importProofs/harness";

export function verifyResolution(
  master: MasterProfile,
  resume: TailoredResume,
  coverage: TailorCoverage,
  role: ListingProfile,
): void {
  const expById = new Map(master.experience.map((e) => [e.id, e]));
  const projById = new Map(master.projects.map((p) => [p.id, p]));
  const idFailures: string[] = [];
  const zoneFailures: string[] = [];
  const gateFailures: string[] = [];

  for (const entry of resume.entries) {
    const masterEntry =
      entry.kind === "experience" ? expById.get(entry.entryId) : projById.get(entry.entryId);
    if (!masterEntry) {
      idFailures.push(entry.entryId);
      continue;
    }
    if (entry.kind === "experience") {
      const e = masterEntry as ExperienceEntry;
      if (entry.heading !== e.org) zoneFailures.push(`${entry.entryId} heading`);
      if (entry.subheading !== e.role) zoneFailures.push(`${entry.entryId} subheading`);
      if ((entry.location ?? "") !== (e.location ?? "")) zoneFailures.push(`${entry.entryId} location`);
      if ((entry.dates ?? "") !== (joinDates(e.startDate, e.endDate) ?? ""))
        zoneFailures.push(`${entry.entryId} dates`);
    } else {
      const p = masterEntry as ProjectEntry;
      if (entry.heading !== p.name) zoneFailures.push(`${entry.entryId} heading`);
      const tech = p.technologies.length > 0 ? p.technologies.join(", ") : undefined;
      if ((entry.subheading ?? "") !== (tech ?? "")) zoneFailures.push(`${entry.entryId} subheading`);
      if ((entry.url ?? "") !== (p.url ?? "")) zoneFailures.push(`${entry.entryId} url`);
      if ((entry.dates ?? "") !== (joinDates(p.startDate, p.endDate) ?? ""))
        zoneFailures.push(`${entry.entryId} dates`);
    }
    const bulletById = new Map(masterEntry.bullets.map((b) => [b.id, b]));
    for (const bullet of entry.bullets) {
      const masterBullet = bulletById.get(bullet.bulletId);
      if (!masterBullet) {
        idFailures.push(`${entry.entryId}/${bullet.bulletId}`);
        continue;
      }
      if (bullet.disposition !== "rephrased" && bullet.text !== masterBullet.text) {
        zoneFailures.push(`${bullet.bulletId} ${bullet.disposition} text differs from master`);
      }
      if (bullet.disposition === "reverted" && !(bullet.offendingTokens?.length)) {
        zoneFailures.push(`${bullet.bulletId} reverted without offendingTokens`);
      }
      if (bullet.disposition === "rephrased") {
        if (normalizeWs(bullet.text) === normalizeWs(masterBullet.text)) {
          gateFailures.push(`${bullet.bulletId}: labeled rephrased but identical`);
        }
        const verdict = checkRephrase({
          candidate: bullet.text,
          sourceBullet: masterBullet.text,
          corpus: groundingCorpus(entry.kind, masterEntry, masterBullet.text),
          roleTechnologies: role.namedTechnologies,
        });
        if (!verdict.ok) {
          gateFailures.push(`${bullet.bulletId}: ${verdict.offendingTokens.join(", ")}`);
        }
      }
    }
  }

  check("every resolved entry/bullet id maps into the master profile", idFailures.length === 0, idFailures.join("; ") || undefined);
  check("model-free zones byte-match master (headings/roles/locations/dates/urls)", zoneFailures.length === 0, zoneFailures.join("; ") || undefined);
  check("client re-run of the pure gates agrees with every 'rephrased' bullet", gateFailures.length === 0, gateFailures.join("; ") || undefined);
  check(
    "coverage.dropped carries ZERO unknown_id drops (alias fidelity observed)",
    !coverage.dropped.some((d) => d.reason === "unknown_id"),
    JSON.stringify(coverage.dropped),
  );

  const counts = countTailored(resume);
  check(
    "coverage counts equal an independent recount of the resume",
    coverage.entriesSelected === counts.entriesSelected &&
      coverage.bulletsSelected === counts.bulletsSelected &&
      coverage.bulletsRephrased === counts.bulletsRephrased &&
      coverage.bulletsReverted === counts.bulletsReverted,
    JSON.stringify({ wire: coverage, recount: counts }),
  );
  check(
    "identity byte-copied from master",
    JSON.stringify(resume.identity) === JSON.stringify(master.identity),
  );
  check(
    "education byte-copied from master",
    JSON.stringify(resume.education) === JSON.stringify(master.education),
  );

  const pool = new Set(
    [
      ...master.skills.flatMap((g) => g.items),
      ...master.projects.flatMap((p) => p.technologies),
    ].map((s) => s.toLowerCase()),
  );
  const groupById = new Map(master.skills.map((g) => [g.id, g]));
  const skillFailures = resume.skills.flatMap((group) => {
    const bad: string[] = [];
    const masterGroup = groupById.get(group.id);
    if (!masterGroup || masterGroup.category !== group.category) {
      bad.push(`category ${group.category}`);
    }
    for (const item of group.items) {
      if (!pool.has(item.toLowerCase())) bad.push(item);
    }
    return bad;
  });
  check(
    "skills are a master subset wearing master categories",
    skillFailures.length === 0,
    skillFailures.join("; ") || undefined,
  );
}

/** The hostile-role proof (§7.13): grep ONLY the fabrication surface — a
 *  full-JSON grep would fail on a correctly-working system, because the
 *  honesty surfaces legitimately carry the word (decisions 39(e)/57). */
export function verifyHostileSurface(resume: TailoredResume, coverage: TailorCoverage): void {
  const surface = [
    ...resume.entries.flatMap((e) => [e.heading, e.subheading ?? "", ...e.bullets.map((b) => b.text)]),
    ...resume.skills.flatMap((g) => [g.category, ...g.items]),
  ]
    .join("\n")
    .toLowerCase();
  check('fabrication surface (bullets/headings/skills) is "kubernetes"-free', !surface.includes("kubernetes"));

  const missing = coverage.keywords.missing.map((k) => k.toLowerCase());
  const offending = resume.entries
    .flatMap((e) => e.bullets)
    .flatMap((b) => b.offendingTokens ?? [])
    .map((t) => t.toLowerCase());
  check(
    "the honesty surfaces DO carry the word (keywords.missing and/or offendingTokens)",
    missing.some((k) => k.includes("kubernetes")) || offending.some((t) => t.includes("kubernetes")),
    JSON.stringify({ missing, offending }),
  );
}
