import { extractListing } from "@/domain/listing/ListingExtractor";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import type { AnalyzeInput, PipelineEvent } from "@/shared/schema";
import type { Clock } from "./clock";
import { isPipelineError } from "./errors";
import { clampBudgetConfig, createRunBudget } from "./RunBudget";
import { cancelledStepSkip, stepSkipped, type StepEvent } from "./steps";

// Stages 1–3 orchestration (PLAN.md §4). Emit-callback design, not a
// generator: Stage 2's parallel fetches (increment 6) must surface events as
// they happen. The SSE adapter (src/server/sse.ts) stamps seq, encodes frames,
// and runs the heartbeat — none of that lives here.
//
// Increment 5 ships Stage 1 only: run.started → extraction → run.completed /
// run.error. Enrichment and synthesis extend the marked seam in increments 6–7.

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

  // Open-step bookkeeping: stage modules emit step pairs through this wrapper
  // so a thrown PipelineError can pair every outstanding step with a
  // `cancelled` skip BEFORE the terminal frame (§3 ordering guarantee 3).
  const openSteps = new Set<string>();
  const emitStep = (event: StepEvent) => {
    if (event.type === "step.started") openSteps.add(event.stepId);
    else openSteps.delete(event.stepId);
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
    const { profile } = await extractListing(
      input,
      { model, fetcher: deps.fetcher },
      { budget, submittedAt, signal: signals.cancel, onStep: emitStep },
    );
    if (signals.cancel.aborted) return;
    emit({ type: "extraction.completed", profile });

    // Increments 6–7 continue here: Stage 2 enrichment, Stage 3 synthesis.

    if (signals.cancel.aborted) return;
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
