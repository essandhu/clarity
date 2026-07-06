import { z } from "zod";
import { urlKey } from "@/domain/enrichment/candidateUrls";
import { isPipelineError } from "@/domain/pipeline/errors";
import { stepOk, stepSkipped, stepStarted, type StepEmit } from "@/domain/pipeline/steps";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import type { EnrichmentResult, Hook, ListingProfile } from "@/shared/schema";
import { hookExtractionPrompt } from "./prompts";
import {
  byKind,
  capExcerpt,
  classifySources,
  HOOK_EXCERPT_CAP,
  MAX_HOOK_SOURCES,
  rankByUrl,
  type ClassifiedSource,
  type SectionExcerpt,
} from "./sectionSources";

// Stage 3 hooks (PLAN.md §4, decision 18): one structured extract() over
// numbered source excerpts, then post-parse citation validation — any hook
// citing a URL that was never actually fetched (and isn't the run's Tier-0
// listing ref) is dropped. Zero hooks is a legal outcome. The whole call is
// covered by its own step pair so the timeline never goes dark.

export const STEP_HOOKS = "synthesis-hooks";
export const MAX_HOOKS = 3;

// What the model is asked for: a lean shape whose citations are raw URL
// strings — domain code maps them back to real SourceRefs and computes
// confidence (never self-reported, decision 16). maxItems is deliberately
// looser than MAX_HOOKS so an overeager model loses its tail, not the run.
const HookExtractionSchema = z.object({
  hooks: z
    .array(
      z.object({
        text: z.string().min(1),
        basis: z.string().min(1),
        sourceUrls: z.array(z.string().min(1)).min(1),
      }),
    )
    .max(10),
});
type RawHook = z.infer<typeof HookExtractionSchema>["hooks"][number];

export interface HookSynthesizerDeps {
  model: ModelProvider;
}

export interface HookSynthesizerOpts {
  cancel: AbortSignal;
  onStep: StepEmit;
}

export async function synthesizeHooks(
  profile: ListingProfile,
  enrichment: EnrichmentResult,
  deps: HookSynthesizerDeps,
  opts: HookSynthesizerOpts,
): Promise<Hook[]> {
  const classified = classifySources(enrichment);
  const known = new Map(classified.map((source) => [urlKey(source.ref.url), source] as const));
  const { system, prompt } = hookExtractionPrompt({
    company: profile.company,
    role: profile.role,
    excerpts: hookExcerpts(classified),
  });
  opts.onStep(stepStarted(STEP_HOOKS, "synthesis", "Finding outreach hooks…"));
  let extracted: z.infer<typeof HookExtractionSchema>;
  try {
    extracted = await deps.model.extract(prompt, HookExtractionSchema, {
      system,
      abortSignal: opts.cancel,
    });
  } catch (err) {
    // A model that cannot produce valid hooks is a degraded outcome, not a
    // dead run: zero hooks is legal (§3) and a run.error here would discard
    // an already-streamed briefing. Aborts and the watchdog's INTERNAL stall
    // error rethrow — the step stays open for the pipeline's terminal pairing
    // (§3 guarantee 3), exactly like a thrown Stage-1 extract.
    if (isPipelineError(err) && err.code === "EXTRACTION_FAILED") {
      opts.onStep(
        stepSkipped(STEP_HOOKS, {
          kind: "skip",
          reason: "empty_content",
          detail: "The model could not produce valid hooks; continuing without them.",
        }),
      );
      return [];
    }
    throw err;
  }
  const hooks = groundHooks(extracted.hooks, known);
  if (hooks.length === 0 && extracted.hooks.length > 0) {
    // Every proposed hook was dropped by citation validation — the drop must
    // be VISIBLE (PLAN.md §4/decision 18: fabrications are traceable), not
    // a clean check mark identical to "nothing hook-worthy in the sources".
    opts.onStep(
      stepSkipped(STEP_HOOKS, {
        kind: "skip",
        reason: "empty_content",
        detail: `The model proposed ${extracted.hooks.length} hook(s), but none cited a fetched source — all were dropped.`,
      }),
    );
    return hooks;
  }
  opts.onStep(stepOk(STEP_HOOKS));
  return hooks;
}

/** The most hook-worthy sources first — blog/changelog posts and news are
 *  specific and recent; the listing is always included (listing-grounded
 *  hooks are legal and cite the Tier-0 ref, decision 33). */
function hookExcerpts(classified: ClassifiedSource[]): SectionExcerpt[] {
  const web = [
    ...rankByUrl(byKind(classified, "blog"), ["changelog"]),
    ...byKind(classified, "news"),
    ...byKind(classified, "github"),
    ...byKind(classified, "site"),
  ].slice(0, MAX_HOOK_SOURCES - 1);
  return [...web, ...byKind(classified, "listing")].map((source) => ({
    ref: source.ref,
    text: capExcerpt(source.text, HOOK_EXCERPT_CAP),
  }));
}

function groundHooks(raw: RawHook[], known: ReadonlyMap<string, ClassifiedSource>): Hook[] {
  const hooks: Hook[] = [];
  const seenTexts = new Set<string>();
  for (const candidate of raw) {
    if (hooks.length >= MAX_HOOKS) break;
    // Citation validation (decision 18): keep only URLs that resolve to a
    // source this run actually holds, deduped by urlKey.
    const cited = new Map<string, ClassifiedSource>();
    for (const url of candidate.sourceUrls) {
      const source = known.get(urlKey(url));
      if (source) cited.set(urlKey(source.ref.url), source);
    }
    if (cited.size === 0) continue; // every citation was fabricated — drop
    const text = candidate.text.trim();
    const basis = candidate.basis.trim();
    if (!text || !basis || seenTexts.has(text)) continue;
    seenTexts.add(text);
    const sources = [...cited.values()];
    hooks.push({
      text,
      basis,
      confidence: sources.every((source) => source.kind === "listing") ? "low" : "high",
      sources: sources.map((source) => source.ref),
    });
  }
  return hooks;
}
