import type { ModelProvider } from "@/providers/model/ModelProvider";
import type {
  Briefing,
  BriefingSection,
  EnrichmentResult,
  ListingProfile,
  PipelineEvent,
} from "@/shared/schema";
import { planSections, type PlannedSection } from "./confidenceRules";
import { sectionSynthesisPrompt } from "./prompts";

// Stage 3 sections (PLAN.md §4): fixed plan, deterministic confidence, serial
// per-section streams (decision 17 — one model stream at a time, no marker
// parsing), zero-source sections canned with NO model call (decision 16).
// Confidence + citations ride synthesis.section.started, so the badge and
// chips render BEFORE the first token (§3 event table).

export type BriefingEvent = Extract<
  PipelineEvent,
  { type: "synthesis.section.started" | "synthesis.delta" | "synthesis.section.completed" }
>;

export interface BriefingSynthesizerDeps {
  model: ModelProvider;
}

export interface BriefingSynthesizerOpts {
  /** User cancel. Checked between sections; a mid-stream abort surfaces as
   *  the model call's throw and the pipeline's silent-return handles it. The
   *  wall-clock deadline never appears here (decision 15). */
  cancel: AbortSignal;
  emit: (event: BriefingEvent) => void;
}

/** Decision 16's canned copy for zero-source sections. */
export const NOT_FOUND_TEXT = "Not found in available sources.";

/** A sourced stream that yields only whitespace still needs schema-valid,
 *  honest content — this names a model shortfall, not a coverage gap. */
export const EMPTY_STREAM_TEXT =
  "The model wrote nothing for this section from the available sources.";

export async function synthesizeBriefing(
  profile: ListingProfile,
  enrichment: EnrichmentResult,
  deps: BriefingSynthesizerDeps,
  opts: BriefingSynthesizerOpts,
): Promise<Briefing> {
  const sections: BriefingSection[] = [];
  for (const planned of planSections(profile, enrichment)) {
    if (opts.cancel.aborted) break; // dead sink — the pipeline returns silently
    opts.emit({
      type: "synthesis.section.started",
      sectionId: planned.id,
      title: planned.title,
      confidence: planned.confidence,
      sources: planned.sources,
    });
    const content =
      planned.confidence === "none"
        ? NOT_FOUND_TEXT
        : await streamSection(planned, profile, deps.model, opts);
    const section: BriefingSection = {
      id: planned.id,
      title: planned.title,
      content,
      confidence: planned.confidence,
      sources: planned.sources,
    };
    sections.push(section);
    // Canonical content replaces the client's streamed buffer (§3).
    opts.emit({ type: "synthesis.section.completed", section });
  }
  return { sections };
}

async function streamSection(
  planned: PlannedSection,
  profile: ListingProfile,
  model: ModelProvider,
  opts: BriefingSynthesizerOpts,
): Promise<string> {
  const { system, prompt } = sectionSynthesisPrompt({
    company: profile.company,
    role: profile.role,
    sectionId: planned.id,
    title: planned.title,
    excerpts: planned.excerpts,
  });
  let streamed = "";
  const stream = model.streamSynthesis({
    system,
    prompt,
    temperature: 0,
    abortSignal: opts.cancel,
  });
  for await (const chunk of stream) {
    if (!chunk) continue;
    streamed += chunk;
    opts.emit({ type: "synthesis.delta", sectionId: planned.id, text: chunk });
  }
  return streamed.trim() || EMPTY_STREAM_TEXT;
}
