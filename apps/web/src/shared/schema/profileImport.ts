import { z } from "zod";
import {
  EducationEntrySchema,
  ExperienceEntrySchema,
  ProjectEntrySchema,
  SkillGroupSchema,
} from "./masterProfile";
import { HttpUrlSchema } from "./sourceRef";

// Import shapes (PLAN-RESUME.md §5): pasted-resume (decision 43, increment
// 11) and GitHub (decision 44, increment 12).

export const ResumeImportRequestSchema = z.object({
  text: z.string().min(40).max(50_000),
});
export type ResumeImportRequest = z.infer<typeof ResumeImportRequestSchema>;

// Model-facing (the pasted-resume extraction target). Deliberately id-less
// and provenance-less — strings and dates only: ids are minted and provenance
// is stamped { origin: 'pasted-resume', importedAt } by the route AFTER
// grounding, so the honesty label is structurally model-inaccessible (the
// TailorSelection/TailoredResume split applied to imports — §4.5).
export const ImportExtractionSchema = z.object({
  experience: z
    .array(
      z.object({
        org: z.string().max(200),
        role: z.string().max(200),
        location: z.string().max(200).optional(),
        startDate: z.string().max(40).optional(),
        endDate: z.string().max(40).optional(),
        bullets: z.array(z.string().max(500)).max(12).default([]),
      }),
    )
    .default([]),
  projects: z
    .array(
      z.object({
        name: z.string().max(200),
        technologies: z.array(z.string().max(60)).default([]),
        startDate: z.string().max(40).optional(),
        endDate: z.string().max(40).optional(),
        bullets: z.array(z.string().max(500)).max(8).default([]),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        school: z.string().max(200),
        degree: z.string().max(200).optional(),
        location: z.string().max(200).optional(),
        startDate: z.string().max(40).optional(),
        endDate: z.string().max(40).optional(),
        notes: z.string().max(300).optional(),
      }),
    )
    .default([]),
  skills: z
    .array(
      z.object({
        category: z.string().max(80),
        items: z.array(z.string().max(80)).max(30).default([]),
      }),
    )
    .default([]),
});
export type ImportExtraction = z.infer<typeof ImportExtractionSchema>;

// What import routes return: real profile entries (ids + provenance stamped)
// the client merges into the editor. Imports never auto-save (decision 42).
export const ImportedEntriesSchema = z.object({
  experience: z.array(ExperienceEntrySchema).default([]),
  projects: z.array(ProjectEntrySchema).default([]),
  education: z.array(EducationEntrySchema).default([]),
  skills: z.array(SkillGroupSchema).default([]),
});
export type ImportedEntries = z.infer<typeof ImportedEntriesSchema>;

// ---------------------------------------------------------------------------
// GitHub import (decision 44 / §4.6). Username and repo names are
// schema-constrained to GitHub's REAL charsets BEFORE any URL is built —
// defense-in-depth under encodeURIComponent.

export const RepoSummarySchema = z.object({
  fullName: z.string(),
  name: z.string(),
  description: z.string().optional(),
  topics: z.array(z.string()).default([]),
  stars: z.number().int().nonnegative(),
  pushedAt: z.iso.datetime(),
  fork: z.boolean(),
  archived: z.boolean(),
  htmlUrl: HttpUrlSchema,
  // Set only when the token-backed pin query succeeded (§6's pinned badge);
  // absent keyless — a documented additive deviation from the §5 sketch.
  pinned: z.boolean().optional(),
});
export type RepoSummary = z.infer<typeof RepoSummarySchema>;

export const GithubUsernameSchema = z.string().regex(/^[A-Za-z0-9-]{1,39}$/);
export const GithubRepoNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

export const GithubReposRequestSchema = z.object({ username: GithubUsernameSchema });
export type GithubReposRequest = z.infer<typeof GithubReposRequestSchema>;

export const GithubImportRequestSchema = z.object({
  username: GithubUsernameSchema,
  repos: z.array(GithubRepoNameSchema).min(1).max(30),
});
export type GithubImportRequest = z.infer<typeof GithubImportRequestSchema>;

export const GithubReposResponseSchema = z.object({
  repos: z.array(RepoSummarySchema),
  // Keyless labels 'stars' honestly — pinned repos are GraphQL/token-only.
  order: z.enum(["pinned-first", "stars"]),
  // From THIS user-initiated call's response headers (or the quota-free
  // /rate_limit endpoint when every page came from the 24h cache) — never
  // from health (decision 56).
  rate: z.object({
    limit: z.number().int(),
    remaining: z.number().int(),
    reset: z.number().int(),
  }),
});
export type GithubReposResponse = z.infer<typeof GithubReposResponseSchema>;

export const ImportReportSchema = z.object({
  // Decision 43 — EVERY gated string that failed, per-string, with its path.
  droppedStrings: z
    .array(
      z.object({
        path: z.string(), // e.g. "experience[1].org", "skills[0].items[3]"
        text: z.string().max(120), // clipped for display
        reason: z.enum(["not-verbatim", "over-cap"]), // format-unparseable LinkedIn dates are KEPT as raw
        //   strings and ride report.notes (§4.7), never dropped;
        //   grounding-FAILED pasted-import dates drop per §4.5
      }),
    )
    .default([]),
  truncated: z.boolean().default(false), // paste exceeded RESUME_IMPORT_MAX
  notes: z.array(z.string()).default([]), // quota skips (github), files read/ignored (linkedin), raw-date keeps
});
export type ImportReport = z.infer<typeof ImportReportSchema>;
