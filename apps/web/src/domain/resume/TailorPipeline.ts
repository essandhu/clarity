import { extractListingFromText } from "@/domain/listing/ListingExtractor";
import { isPipelineError, toRunErrorEvent } from "@/domain/pipeline/errors";
import {
  cancelledStepSkip,
  stepOk,
  stepSkipped,
  stepStarted,
  type StepEvent,
} from "@/domain/pipeline/steps";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import {
  TailorSelectionSchema,
  type MasterProfile,
  type PipelineEvent,
  type TailorCoverage,
  type TailorRoleInput,
  type TailorSelection,
} from "@/shared/schema";
import { fallbackSelection } from "./fallbackSelection";
import { resolveTailoredResume } from "./tailorGrounding";
import { tailorSelectionPrompt } from "./tailorPrompt";

// The tailor run (PLAN-RESUME.md §4.1) — runDraft's shape: synchronous
// .started at seq 0, silent-return-on-abort, toRunErrorEvent, plus the
// analysis pipeline's open-step bookkeeping so a thrown error pairs
// stragglers before the terminal frame (§3 guarantee 3). The tailor never
// touches the network: no fetches, no RunBudget — the master profile arrives
// loaded (decision 37) and the role is a profile or a paste (decision 35).

export const STEP_TAILOR_ROLE = "tailor-role-extract";
export const STEP_TAILOR_SELECT = "tailor-select";

/** The honest skipped-step detail for decision 40's degradation arm. */
export const FALLBACK_SKIP_DETAIL =
  "model selection failed after repair — resume rendered untailored by recency";

export type EmitTailorEvent = (event: PipelineEvent) => void;

export interface TailorDeps {
  /** Lazy: a misconfigured provider surfaces as run.error ON the stream. */
  getModel(): ModelProvider;
}

export interface TailorSignals {
  cancel: AbortSignal;
}

export async function runTailor(
  role: TailorRoleInput,
  master: MasterProfile,
  deps: TailorDeps,
  emit: EmitTailorEvent,
  signals: TailorSignals,
): Promise<void> {
  emit({ type: "tailor.started" });
  const openSteps = new Set<string>();
  const track = (event: StepEvent) => {
    if (event.type === "step.started") openSteps.add(event.stepId);
    else openSteps.delete(event.stepId);
    emit(event);
  };
  try {
    if (signals.cancel.aborted) return;
    const model = deps.getModel();

    // Text path only: the reused Stage-1 extraction under a tailor-stage
    // step pair, then the profile on the wire for ProfileCard (§3 ordering:
    // both precede the selection step pair). The profile path posts a
    // ListingProfile verbatim — no extraction step appears in that stream.
    let roleProfile;
    if (role.kind === "text") {
      track(stepStarted(STEP_TAILOR_ROLE, "tailor", "Extracting role profile…"));
      roleProfile = await extractListingFromText(role.text, model, signals.cancel);
      track(stepOk(STEP_TAILOR_ROLE));
      if (signals.cancel.aborted) return;
      emit({ type: "tailor.role.completed", profile: roleProfile });
    } else {
      roleProfile = role.profile;
    }

    if (signals.cancel.aborted) return;
    const { system, prompt, ctx } = tailorSelectionPrompt(master, roleProfile);
    track(stepStarted(STEP_TAILOR_SELECT, "tailor", "Selecting from your master profile…"));
    let selection: TailorSelection;
    let mode: TailorCoverage["mode"] = "tailored";
    try {
      selection = await model.extract(prompt, TailorSelectionSchema, {
        system,
        temperature: 0,
        abortSignal: signals.cancel,
        streamProgress: true, // decision 58: deltas feed the watchdog
      });
      track(stepOk(STEP_TAILOR_SELECT));
    } catch (err) {
      // Decision 40: ONLY a post-repair model selection failure degrades to
      // the recency fallback — aborts and watchdog stalls (INTERNAL) rethrow.
      if (signals.cancel.aborted || !isPipelineError(err) || err.code !== "EXTRACTION_FAILED") {
        throw err;
      }
      track(
        stepSkipped(STEP_TAILOR_SELECT, {
          kind: "skip",
          reason: "empty_content",
          detail: FALLBACK_SKIP_DETAIL,
        }),
      );
      selection = fallbackSelection(master, ctx);
      mode = "fallback-untailored";
    }

    if (signals.cancel.aborted) return;
    const { resume, coverage } = resolveTailoredResume(selection, master, roleProfile, ctx, mode);
    emit({ type: "tailor.completed", resume, coverage });
  } catch (err) {
    // Silent-return-on-abort: the sink is dead by definition; the client
    // reducer closes open rows locally (§3 guarantee 3).
    if (signals.cancel.aborted) return;
    for (const stepId of openSteps) {
      emit(stepSkipped(stepId, cancelledStepSkip("run terminated")));
    }
    emit(toRunErrorEvent(err));
  }
}
