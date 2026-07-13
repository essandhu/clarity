import { z } from "zod";
import { ListingProfileSchema } from "./listingProfile";
import { EducationEntrySchema, MasterProfileSchema, SkillGroupSchema } from "./masterProfile";
import { HttpUrlSchema } from "./sourceRef";

// The tailoring shapes (PLAN-RESUME.md §5, decisions 38/39/41/57). Two
// deliberately different worlds: TailorSelection is MODEL-FACING (shallow,
// flat arrays, prompt-alias ids, optional rephrased — absent means
// all-verbatim, decision 38); TailoredResume is the RESOLVED document the
// fold produces (real ids, per-bullet dispositions, verbatim master copies).
// The model never emits a TailoredResume and never sees a UUID.
// RenderRequestSchema lands with its consumer, the increment-14 render route
// (the profileImport no-scaffolding precedent).

// A role is a ListingProfile everywhere (decision 35): the handoff posts one
// verbatim; the pasted path reuses the Stage-1 extraction to build one.
export const TailorRoleInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), profile: ListingProfileSchema }),
  z.object({ kind: z.literal("text"), text: z.string().min(40).max(50_000) }),
]);
export type TailorRoleInput = z.infer<typeof TailorRoleInputSchema>;

// Model-facing. The id VALUES the model sees and echoes are the prompt's
// short ordinal aliases (e1, e1b2 — §4.2 gate 1); the fold translates
// alias→UUID. `rephrased` is OPTIONAL (decision 38) — absent means
// all-verbatim dispositions; that IS the pre-decided degradation shape,
// tested in its own right, not a contingency.
export const TailorSelectionSchema = z.object({
  entries: z
    .array(
      z.object({
        entryId: z.string(),
        bulletIds: z.array(z.string()).max(6),
        rephrased: z
          .array(z.object({ bulletId: z.string(), text: z.string().max(400) }))
          .optional(),
      }),
    )
    .max(12),
  skills: z
    .array(
      z.object({
        category: z.string().max(60),
        items: z.array(z.string().max(80)).max(15),
      }),
    )
    .max(6),
});
export type TailorSelection = z.infer<typeof TailorSelectionSchema>;

export const BulletDispositionSchema = z.enum(["verbatim", "rephrased", "reverted"]);
export type BulletDisposition = z.infer<typeof BulletDispositionSchema>;

export const TailoredBulletSchema = z.object({
  bulletId: z.string().min(1),
  text: z.string().min(1).max(500),
  disposition: BulletDispositionSchema,
  // Present iff disposition === 'reverted' — the exact tokens the gates
  // blocked, so the UI can say "kept your wording — would have added: X, Y".
  offendingTokens: z.array(z.string().max(60)).optional(),
});
export type TailoredBullet = z.infer<typeof TailoredBulletSchema>;

export const TailoredEntrySchema = z.object({
  entryId: z.string().min(1),
  kind: z.enum(["experience", "project"]),
  heading: z.string().min(1), // org or project name — copied verbatim from master
  subheading: z.string().optional(), // role / tech list — verbatim or mechanical join
  location: z.string().optional(),
  dates: z.string().optional(), // "Jan 2020 -- Present", mechanical join
  url: HttpUrlSchema.optional(),
  bullets: z.array(TailoredBulletSchema).max(6),
});
export type TailoredEntry = z.infer<typeof TailoredEntrySchema>;

export const TailoredResumeSchema = z.object({
  roleLabel: z.string().min(1), // "<role> at <company>", mechanical
  identity: MasterProfileSchema.shape.identity, // byte-copied from master
  entries: z.array(TailoredEntrySchema).max(10),
  education: z.array(EducationEntrySchema).max(10), // byte-copied from master
  skills: z.array(SkillGroupSchema).max(6), // gate-5 survivors; ids + categories come
}); //   from the matched MASTER groups (§4.2 gate 5)
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

export const TailorCoverageSchema = z.object({
  mode: z.enum(["tailored", "fallback-untailored"]), // decision 40
  entriesTotal: z.number().int().nonnegative(),
  entriesOffered: z.number().int().nonnegative(), // < entriesTotal = prompt-cap truncation, rendered
  entriesSelected: z.number().int().nonnegative(),
  bulletsSelected: z.number().int().nonnegative(),
  bulletsRephrased: z.number().int().nonnegative(),
  bulletsReverted: z.number().int().nonnegative(),
  dropped: z.array(
    z.object({
      kind: z.enum(["entry", "bullet", "skill"]),
      reason: z.enum(["unknown_id", "not_subset", "over_cap"]),
      count: z.number().int().positive(),
      // Clipped names so the UI can say "not added (not in your profile): …"
      samples: z.array(z.string().max(60)).max(10).default([]),
    }),
  ),
  keywords: z.object({
    // Decision 57 — display-only by construction: nothing but the coverage
    // card reads it, so it is structurally incapable of entering the resume.
    matched: z.array(z.string().max(60)),
    missing: z.array(z.string().max(60)),
  }),
});
export type TailorCoverage = z.infer<typeof TailorCoverageSchema>;
