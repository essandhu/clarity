import { z } from "zod";
import { BriefingSectionSchema, ConfidenceSchema, SECTION_PLAN } from "./briefing";
import { DraftNoteSchema } from "./draftNote";
import { EnrichmentWireSummarySchema, TierNumberSchema, TierStatusSchema } from "./enrichment";
import { FetchSkipSchema } from "./fetch";
import { HookSchema } from "./hook";
import { ListingProfileSchema } from "./listingProfile";
import { HttpUrlSchema, SourceRefSchema } from "./sourceRef";

export const StageSchema = z.enum(["extraction", "enrichment", "synthesis"]);
export type Stage = z.infer<typeof StageSchema>;

// Fatal only — a dead careers page is never a run.error. These four codes are
// the only thing that can terminate a run (PLAN.md decision 21).
export const RunErrorCodeSchema = z.enum([
  "INPUT_INVALID",
  "MODEL_UNCONFIGURED",
  "EXTRACTION_FAILED",
  "INTERNAL",
]);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;

// The wire protocol. This exact union is emitted by the domain, serialized by
// the SSE adapter, and re-parsed by the client reducer — one schema, no drift.
export const PipelineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.started"),
    runId: z.string(),
    provider: z.object({ id: z.string() }),
    budget: z.object({ maxFetches: z.number().int(), deadlineMs: z.number().int() }),
    input: z.object({ kind: z.enum(["url", "text"]) }),
  }),
  // Every 10s during long model calls; liveness only, exempt from ordering.
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("stage.started"), stage: StageSchema }),
  z.object({
    type: z.literal("step.started"),
    stepId: z.string(),
    stage: StageSchema,
    label: z.string(),
    url: HttpUrlSchema.optional(),
    tier: TierNumberSchema.optional(),
  }),
  z.object({
    type: z.literal("step.finished"),
    stepId: z.string(),
    status: z.enum(["ok", "skipped"]),
    skip: FetchSkipSchema.optional(),
    source: SourceRefSchema.optional(),
    cached: z.boolean().optional(),
  }),
  z.object({ type: z.literal("extraction.completed"), profile: ListingProfileSchema }),
  z.object({
    type: z.literal("enrichment.tier.completed"),
    tier: TierNumberSchema,
    status: TierStatusSchema,
    sources: z.array(SourceRefSchema),
  }),
  // Informational, at most once per kind; the run continues to synthesis.
  z.object({
    type: z.literal("budget.exhausted"),
    kind: z.enum(["fetches", "wall_clock"]),
    fetchesUsed: z.number().int(),
    elapsedMs: z.number().int(),
    skippedTiers: z.array(z.number().int()),
  }),
  z.object({ type: z.literal("enrichment.completed"), summary: EnrichmentWireSummarySchema }),
  // Confidence + citations computed from coverage BEFORE generation, so the
  // badge and chips render before the first token.
  z.object({
    type: z.literal("synthesis.section.started"),
    sectionId: z.enum(SECTION_PLAN),
    title: z.string(),
    confidence: ConfidenceSchema,
    sources: z.array(SourceRefSchema),
  }),
  z.object({
    type: z.literal("synthesis.delta"),
    sectionId: z.enum(SECTION_PLAN),
    text: z.string(),
  }),
  z.object({ type: z.literal("synthesis.section.completed"), section: BriefingSectionSchema }),
  z.object({ type: z.literal("synthesis.hooks.completed"), hooks: z.array(HookSchema).max(3) }),
  z.object({
    type: z.literal("run.completed"),
    runId: z.string(),
    elapsedMs: z.number().int(),
    fetchCount: z.number().int(),
  }),
  z.object({
    type: z.literal("run.error"),
    code: RunErrorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
    stage: z.string().optional(),
  }),
  // The draft stream reuses the envelope:
  z.object({ type: z.literal("draft.started") }),
  z.object({ type: z.literal("draft.delta"), text: z.string() }),
  z.object({ type: z.literal("draft.completed"), note: DraftNoteSchema }),
]);
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
