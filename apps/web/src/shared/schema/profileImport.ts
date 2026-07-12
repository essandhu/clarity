import { z } from "zod";
import {
  EducationEntrySchema,
  ExperienceEntrySchema,
  ProjectEntrySchema,
  SkillGroupSchema,
} from "./masterProfile";

// Pasted-resume import shapes (PLAN-RESUME.md §5, decision 43). The GitHub
// import schemas join this file in increment 12.

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
