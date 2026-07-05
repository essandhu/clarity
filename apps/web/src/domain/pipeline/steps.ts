import type { FetchSkip, PipelineEvent, SourceRef, Stage, TierNumber } from "@/shared/schema";

// Step-event constructors shared by the pipeline and the stage modules
// (ListingExtractor now; CompanyEnricher and the synthesizers in increments
// 6–7). Pre-split helper under the ~200-line ceiling — the wire shapes live in
// shared/schema; this only assembles them.

export type StepEvent = Extract<PipelineEvent, { type: "step.started" | "step.finished" }>;

/** The sink stage modules emit step pairs into; the pipeline wraps the run's
 *  emit with open-step bookkeeping so a thrown error can pair stragglers. */
export type StepEmit = (event: StepEvent) => void;

export function stepStarted(
  stepId: string,
  stage: Stage,
  label: string,
  extra?: { url?: string; tier?: TierNumber },
): StepEvent {
  return { type: "step.started", stepId, stage, label, url: extra?.url, tier: extra?.tier };
}

export function stepOk(
  stepId: string,
  extra?: { source?: SourceRef; cached?: boolean },
): StepEvent {
  return {
    type: "step.finished",
    stepId,
    status: "ok",
    source: extra?.source,
    cached: extra?.cached,
  };
}

export function stepSkipped(stepId: string, skip: FetchSkip): StepEvent {
  return { type: "step.finished", stepId, status: "skipped", skip };
}

/** The pairing skip for steps torn down by a server-side terminal (§3
 *  ordering guarantee 3). No `url`: these are not fetch outcomes. */
export function cancelledStepSkip(detail?: string): FetchSkip {
  return { kind: "skip", reason: "cancelled", detail };
}
