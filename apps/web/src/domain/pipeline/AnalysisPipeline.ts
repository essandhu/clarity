import { enrichCompany } from "@/domain/enrichment/CompanyEnricher";
import { toWireSummary } from "@/domain/enrichment/coverage";
import { extractListing } from "@/domain/listing/ListingExtractor";
import { synthesizeBriefing } from "@/domain/synthesis/BriefingSynthesizer";
import { synthesizeHooks } from "@/domain/synthesis/HookSynthesizer";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import type { AnalyzeInput, PipelineEvent } from "@/shared/schema";
import type { Clock } from "./clock";
import { isPipelineError } from "./errors";
import { clampBudgetConfig, createRunBudget } from "./RunBudget";
import { cancelledStepSkip, stepSkipped } from "./steps";

// Stages 1–3 orchestration (PLAN.md §4). Emit-callback design, not a
// generator: Stage 2's parallel fetches must surface events as they happen.
// The SSE adapter (src/server/sse.ts) stamps seq, encodes frames, and runs
// the heartbeat — none of that lives here.
//
// Increments 5–6 ship Stages 1–2: run.started → extraction → enrichment →
// run.completed / run.error. Synthesis extends the marked seam in increment 7.

export type EmitEvent = (event: PipelineEvent) => void;

export interface PipelineSignals {
  /** User cancellation. On abort the function returns SILENTLY — the sink is
   *  dead by definition; the client reducer closes open steps locally (§3
   *  ordering guarantee 3). */
  cancel: AbortSignal;
}

export interface PipelineDeps {
  /** Provider id for run.started ('unconfigured' when selection failed — the
   *  run then fails on the stream with MODEL_UNCONFIGURED, after run.started). */
  providerId: string;
  /** Lazy so a misconfigured provider surfaces as run.error ON the stream,
   *  never as a route crash before the first frame. */
  getModel(): ModelProvider;
  fetcher: PageFetcher;
  clock: Clock;
  budget: { maxFetches: number; deadlineMs: number };
  /** Real-timer seam, injected by the route adapter; the domain stays
   *  timer-free (decision 22). Returns a disposer. */
  scheduleDeadline?: (fire: () => void, afterMs: number) => () => void;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID. */
  newRunId?: () => string;
}

export async function runAnalysis(
  input: AnalyzeInput,
  deps: PipelineDeps,
  emit: EmitEvent,
  signals: PipelineSignals,
): Promise<void> {
  const { clock } = deps;
  const startedAt = clock.now();
  const runId = deps.newRunId?.() ?? crypto.randomUUID();
  const knobs = clampBudgetConfig(deps.budget);
  const budget = createRunBudget({ ...knobs, cancel: signals.cancel }, clock);
  const disposeDeadline = deps.scheduleDeadline?.(() => budget.fireDeadline(), knobs.deadlineMs);

  // Open-step bookkeeping: stage modules emit their events through this
  // wrapper so a thrown PipelineError can pair every outstanding step with a
  // `cancelled` skip BEFORE the terminal frame (§3 ordering guarantee 3).
  // Non-step events (tier/budget frames from the enricher) pass through.
  const openSteps = new Set<string>();
  const track = (event: PipelineEvent) => {
    if (event.type === "step.started") openSteps.add(event.stepId);
    else if (event.type === "step.finished") openSteps.delete(event.stepId);
    emit(event);
  };

  emit({
    type: "run.started",
    runId,
    provider: { id: deps.providerId },
    budget: knobs,
    input: { kind: input.kind },
  });

  try {
    if (signals.cancel.aborted) return;
    emit({ type: "stage.started", stage: "extraction" });
    const model = deps.getModel();
    const submittedAt = new Date(clock.now()).toISOString();
    const { profile, listingSource } = await extractListing(
      input,
      { model, fetcher: deps.fetcher },
      { budget, submittedAt, signal: signals.cancel, onStep: track },
    );
    if (signals.cancel.aborted) return;
    emit({ type: "extraction.completed", profile });

    // Stage 2 — never fatal (decision 21): every failure inside comes back
    // as a typed skip folded into coverage.
    if (signals.cancel.aborted) return;
    emit({ type: "stage.started", stage: "enrichment" });
    const enrichment = await enrichCompany(
      profile,
      listingSource,
      { fetcher: deps.fetcher },
      { budget, clock, runStartedAt: startedAt, cancel: signals.cancel, emit: track },
    );
    if (signals.cancel.aborted) return;
    emit({ type: "enrichment.completed", summary: toWireSummary(enrichment) });

    // Stage 3 — synthesis. The wall-clock deadline bounds fetching only
    // (decision 15): model streams run under the user cancel signal plus the
    // provider-level inactivity watchdog, so a deadline that fired during
    // enrichment never kills a progressing briefing stream. A watchdog stall
    // or provider crash propagates to the outer catch as run.error INTERNAL.
    if (signals.cancel.aborted) return;
    emit({ type: "stage.started", stage: "synthesis" });
    await synthesizeBriefing(
      profile,
      enrichment,
      { model },
      { cancel: signals.cancel, emit: track },
    );
    if (signals.cancel.aborted) return;
    const hooks = await synthesizeHooks(
      profile,
      enrichment,
      { model },
      { cancel: signals.cancel, onStep: track },
    );
    if (signals.cancel.aborted) return;
    emit({ type: "synthesis.hooks.completed", hooks });
    emit({
      type: "run.completed",
      runId,
      elapsedMs: clock.now() - startedAt,
      fetchCount: budget.fetchesUsed(),
    });
  } catch (err) {
    // Silent-return-on-abort: a user cancel can surface as ANY error shape
    // (a `cancelled` fetch skip already mapped to INPUT_INVALID, an
    // AbortError from the model call), so the cancel signal — not the error
    // type — decides. No pairing frames either: undeliverable by definition.
    if (signals.cancel.aborted) return;
    for (const stepId of openSteps) {
      emit(stepSkipped(stepId, cancelledStepSkip("run terminated")));
    }
    emit(toRunError(err));
  } finally {
    disposeDeadline?.();
  }
}

function toRunError(err: unknown): Extract<PipelineEvent, { type: "run.error" }> {
  if (isPipelineError(err)) {
    return {
      type: "run.error",
      code: err.code,
      message: err.message,
      hint: err.hint,
      stage: err.stage,
    };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return {
    type: "run.error",
    code: "INTERNAL",
    message: `Unexpected error: ${detail}`,
  };
}
