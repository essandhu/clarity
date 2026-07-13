import type {
  EducationEntry,
  ExperienceEntry,
  ImportReport,
  ProjectEntry,
  SkillGroup,
} from "@/shared/schema";
import { HttpUrlSchema } from "@/shared/schema";
import { parseLinkedinDate, type LinkedinRow, type LinkedinRows } from "./linkedinCsv";

// Row -> entry builders for the LinkedIn mapping (pre-split from
// linkedinMapping.ts under the 200-line ceiling). All pure; ids come from
// the injected mint (node:crypto never in domain, §4.4). Values the profile
// schema would reject are DROPPED with per-string 'over-cap' report entries
// (the increment-11 honesty shape), never clipped — a clipped line is no
// longer the user's line.

export interface LinkedinMappingDeps {
  mintId(): string;
  importedAt: string;
}

export interface LinkedinMapContext {
  deps: LinkedinMappingDeps;
  dropped: ImportReport["droppedStrings"];
  notes: string[];
}

const clip = (text: string) => text.slice(0, 120);
const field = (row: LinkedinRow, column: string): string | undefined => {
  const value = row[column]?.trim();
  return value ? value : undefined;
};

function overCap(ctx: LinkedinMapContext, path: string, text: string): undefined {
  ctx.dropped.push({ path, text: clip(text), reason: "over-cap" });
  return undefined;
}

function fitted(
  ctx: LinkedinMapContext,
  path: string,
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : overCap(ctx, path, value);
}

/** Format-list date with the raw-string fallback SURFACED in notes (§4.7). */
function dateField(
  ctx: LinkedinMapContext,
  fileLabel: string,
  path: string,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const display = parseLinkedinDate(raw);
  if (display !== undefined) return display;
  if (raw.length > 40) return overCap(ctx, path, raw);
  ctx.notes.push(`${fileLabel}: kept "${raw}" as written (unrecognized date format).`);
  return raw;
}

/** Multiline Description -> bullets, split on newlines (§4.7). */
function bullets(
  ctx: LinkedinMapContext,
  pathBase: string,
  description: string | undefined,
  maxBullets: number,
): { id: string; text: string }[] {
  if (description === undefined) return [];
  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const out: { id: string; text: string }[] = [];
  lines.forEach((line, index) => {
    if (line.length > 500) {
      overCap(ctx, `${pathBase}[${index}]`, line);
      return;
    }
    if (out.length >= maxBullets) {
      overCap(ctx, `${pathBase}[${index}]`, line);
      return;
    }
    out.push({ id: ctx.deps.mintId(), text: line });
  });
  return out;
}

const provenance = (deps: LinkedinMappingDeps) =>
  ({ origin: "linkedin-export", importedAt: deps.importedAt }) as const;

/** A row whose HEADING field (org/role, school, name) is missing or
 *  over-cap cannot stand — the whole row is dropped, and the drop is
 *  VISIBLE: over-cap headings get a row-scoped droppedStrings entry (the
 *  rest of the row falls with it — review C3), missing headings get a note.
 *  All report paths are in the SOURCE file's row-index base (`positions[3]`
 *  is the 4th CSV row, kept or not) so one report never mixes two numbering
 *  schemes — the increment-11 F8 rule (review C2). */
function droppedRow(
  ctx: LinkedinMapContext,
  fileLabel: string,
  rowPath: string,
  overCapValue: string | undefined,
  missingCopy: string,
): void {
  if (overCapValue !== undefined) overCap(ctx, rowPath, overCapValue);
  else ctx.notes.push(`${fileLabel}: skipped a row with no ${missingCopy}.`);
}

/** Positions.csv / Volunteering.csv -> experience. Volunteer roles are
 *  suffixed "(volunteer)"; a blank Finished On means a current role (absent
 *  end date). */
export function positionEntries(
  ctx: LinkedinMapContext,
  rows: LinkedinRow[],
  volunteer: boolean,
): ExperienceEntry[] {
  const fileLabel = volunteer ? "Volunteering" : "Positions";
  const base = volunteer ? "volunteering" : "positions";
  const out: ExperienceEntry[] = [];
  rows.forEach((row, rowIndex) => {
    const path = (leaf: string) => `${base}[${rowIndex}].${leaf}`;
    const org = field(row, "Company Name");
    const rawRole = field(row, volunteer ? "Role" : "Title");
    const role = rawRole !== undefined && volunteer ? `${rawRole} (volunteer)` : rawRole;
    if (org === undefined || role === undefined || org.length > 200 || role.length > 200) {
      droppedRow(
        ctx,
        fileLabel,
        `${base}[${rowIndex}]`,
        org !== undefined && org.length > 200 ? org : role !== undefined && role.length > 200 ? role : undefined,
        volunteer ? "Company Name/Role" : "Company Name/Title",
      );
      return;
    }
    const location = fitted(ctx, path("location"), field(row, "Location"), 200);
    const startDate = dateField(ctx, fileLabel, path("startDate"), field(row, "Started On"));
    const endDate = dateField(ctx, fileLabel, path("endDate"), field(row, "Finished On"));
    out.push({
      id: ctx.deps.mintId(),
      org,
      role,
      ...(location !== undefined ? { location } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      bullets: bullets(ctx, path("bullets"), field(row, "Description"), 12),
      provenance: provenance(ctx.deps),
    });
  });
  return out;
}

export function educationEntries(ctx: LinkedinMapContext, rows: LinkedinRow[]): EducationEntry[] {
  const out: EducationEntry[] = [];
  rows.forEach((row, rowIndex) => {
    const path = (leaf: string) => `education[${rowIndex}].${leaf}`;
    const school = field(row, "School Name");
    if (school === undefined || school.length > 200) {
      droppedRow(ctx, "Education", `education[${rowIndex}]`, school, "School Name");
      return;
    }
    const degree = fitted(ctx, path("degree"), field(row, "Degree Name"), 200);
    const notes = fitted(ctx, path("notes"), field(row, "Notes"), 300);
    const startDate = dateField(ctx, "Education", path("startDate"), field(row, "Start Date"));
    const endDate = dateField(ctx, "Education", path("endDate"), field(row, "End Date"));
    out.push({
      id: ctx.deps.mintId(),
      school,
      ...(degree !== undefined ? { degree } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      provenance: provenance(ctx.deps),
    });
  });
  return out;
}

export function projectEntries(ctx: LinkedinMapContext, rows: LinkedinRow[]): ProjectEntry[] {
  const out: ProjectEntry[] = [];
  rows.forEach((row, rowIndex) => {
    const path = (leaf: string) => `projects[${rowIndex}].${leaf}`;
    const name = field(row, "Title");
    if (name === undefined || name.length > 200) {
      droppedRow(ctx, "Projects", `projects[${rowIndex}]`, name, "Title");
      return;
    }
    const rawUrl = field(row, "Url");
    const url = rawUrl !== undefined && HttpUrlSchema.safeParse(rawUrl).success ? rawUrl : undefined;
    if (rawUrl !== undefined && url === undefined) {
      ctx.notes.push(`Projects: dropped the link for "${clip(name)}" (not a valid http(s) URL).`);
    }
    const startDate = dateField(ctx, "Projects", path("startDate"), field(row, "Started On"));
    const endDate = dateField(ctx, "Projects", path("endDate"), field(row, "Finished On"));
    out.push({
      id: ctx.deps.mintId(),
      name,
      ...(url !== undefined ? { url } : {}),
      technologies: [],
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      bullets: bullets(ctx, path("bullets"), field(row, "Description"), 8),
      provenance: provenance(ctx.deps),
    });
  });
  return out;
}

/** Skills / Certifications / Honors / Languages -> skill groups. Items over
 *  the 80-char schema cap are dropped + reported; groups chunk at 30 items
 *  (the SkillGroupSchema max) under DISTINCT categories ("Skills",
 *  "Skills (2)", …) — same-category chunks would collide in profileMerge's
 *  category union, whose 30-item group cap would silently strand every item
 *  past 30 as a false "already present" skip (review C4). */
export function skillGroups(ctx: LinkedinMapContext, rows: LinkedinRows): SkillGroup[] {
  const groups: SkillGroup[] = [];
  const add = (category: string, items: (string | undefined)[]) => {
    const kept: string[] = [];
    items.forEach((item, index) => {
      if (item === undefined) return;
      if (item.length > 80) {
        overCap(ctx, `skills[${category}].items[${index}]`, item);
        return;
      }
      kept.push(item);
    });
    for (let i = 0, chunk = 1; i < kept.length; i += 30, chunk += 1) {
      groups.push({
        id: ctx.deps.mintId(),
        category: chunk === 1 ? category : `${category} (${chunk})`,
        items: kept.slice(i, i + 30),
      });
    }
  };
  add("Skills", (rows.skills ?? []).map((row) => field(row, "Name")));
  add("Certifications", (rows.certifications ?? []).map((row) => field(row, "Name")));
  add("Honors & Awards", (rows.honors ?? []).map((row) => field(row, "Title")));
  add(
    "Languages",
    (rows.languages ?? []).map((row) => {
      const name = field(row, "Name");
      if (name === undefined) return undefined;
      const proficiency = field(row, "Proficiency");
      return proficiency !== undefined ? `${name} (${proficiency})` : name;
    }),
  );
  return groups;
}
