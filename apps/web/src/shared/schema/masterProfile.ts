import { z } from "zod";
import { HttpUrlSchema, SourceRefSchema } from "./sourceRef";

// The master profile (PLAN-RESUME.md §5, decisions 37/47): the disk-truth
// content source every tailoring run selects from. Entry text is USER truth —
// imported through verbatim gates or typed by hand — never model-authored.
// Dates are raw display strings ("Jan 2020"), never re-derived: re-deriving
// would be a fabrication channel wearing a formatting hat.

export const ProfileBulletSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
});
export type ProfileBullet = z.infer<typeof ProfileBulletSchema>;

// The honesty label: where an entry came from. Stamped by routes/mappers
// AFTER grounding — the model-facing import schema (profileImport.ts) has no
// provenance field, so the label is structurally model-inaccessible.
export const ProvenanceSchema = z.object({
  origin: z.enum(["manual", "pasted-resume", "linkedin-export", "github-api"]),
  ref: SourceRefSchema.optional(), // github entries cite html_url
  importedAt: z.iso.datetime(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ExperienceEntrySchema = z.object({
  id: z.string().min(1),
  org: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  location: z.string().max(200).optional(),
  // Raw display strings, never re-derived.
  startDate: z.string().max(40).optional(),
  endDate: z.string().max(40).optional(),
  bullets: z.array(ProfileBulletSchema).max(12),
  provenance: ProvenanceSchema,
});
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;

export const ProjectEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  url: HttpUrlSchema.optional(),
  technologies: z.array(z.string().max(60)).default([]),
  startDate: z.string().max(40).optional(),
  endDate: z.string().max(40).optional(),
  bullets: z.array(ProfileBulletSchema).max(8),
  provenance: ProvenanceSchema,
  github: z
    .object({
      fullName: z.string(),
      stars: z.number().int().nonnegative(),
      pushedAt: z.iso.datetime(),
      languages: z.record(z.string(), z.number().int()),
    })
    .optional(),
});
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const EducationEntrySchema = z.object({
  id: z.string().min(1),
  school: z.string().min(1).max(200),
  degree: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  startDate: z.string().max(40).optional(),
  endDate: z.string().max(40).optional(),
  notes: z.string().max(300).optional(),
  provenance: ProvenanceSchema,
});
export type EducationEntry = z.infer<typeof EducationEntrySchema>;

export const SkillGroupSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1).max(80),
  items: z.array(z.string().min(1).max(80)).max(30),
});
export type SkillGroup = z.infer<typeof SkillGroupSchema>;

export const MasterProfileSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    name: z.string().min(1).max(120),
    email: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
    location: z.string().max(120).optional(),
    links: z
      .array(z.object({ label: z.string().min(1).max(60), url: HttpUrlSchema }))
      .max(4)
      .default([]),
  }),
  experience: z.array(ExperienceEntrySchema).max(30).default([]),
  projects: z.array(ProjectEntrySchema).max(30).default([]),
  education: z.array(EducationEntrySchema).max(10).default([]),
  skills: z.array(SkillGroupSchema).max(10).default([]),
  updatedAt: z.iso.datetime(),
});
export type MasterProfile = z.infer<typeof MasterProfileSchema>;

// PUT /api/profile body (§3): overwrite must be EXPLICIT when the disk state
// is unreadable — a blind save over a corrupt-but-recoverable file is refused
// with 409 (decision 47).
export const ProfilePutRequestSchema = z.object({
  profile: MasterProfileSchema,
  overwrite: z.boolean().optional(),
});
export type ProfilePutRequest = z.infer<typeof ProfilePutRequestSchema>;

/** An empty valid profile — the editor's starting state before any import. */
export function emptyMasterProfile(name: string, updatedAt: string): MasterProfile {
  return {
    version: 1,
    identity: { name, links: [] },
    experience: [],
    projects: [],
    education: [],
    skills: [],
    updatedAt,
  };
}
