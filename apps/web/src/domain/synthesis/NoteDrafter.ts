import { toRunErrorEvent } from "@/domain/pipeline/errors";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import type { DraftNote, DraftRequest, Hook, PipelineEvent } from "@/shared/schema";
import { draftNotePrompt } from "./prompts";

// The streamed draft note (PLAN.md §4 NoteDrafter, decision 25): the body
// streams via streamSynthesis from the user-visible hooks (+ the optional
// selected contact), then an extract()-free assembly computes groundedHooks —
// a validated verbatim subset of the supplied hook texts — before
// draft.completed. Deliberately OUTSIDE runAnalysis (decision 27): /api/draft
// is its own user-initiated stream. The provider-internal inactivity watchdog
// bounds the stream; a stall surfaces as run.error INTERNAL on this stream.

export type EmitDraftEvent = (event: PipelineEvent) => void;

export interface NoteDrafterDeps {
  /** Lazy for the same reason as the pipeline's: a misconfigured provider
   *  must surface as run.error ON the stream, never as a route crash. */
  getModel(): ModelProvider;
}

export interface NoteDrafterSignals {
  cancel: AbortSignal;
}

// The UI never shows more than 3 hooks (the wire caps synthesis.hooks at 3),
// but DraftRequest arrives from the client — cap here so an oversized hooks
// array cannot blow the risk-14 prompt budget. Applied ONCE at entry, so the
// prompt and groundedHooks agree on which hooks were offered.
export const DRAFT_MAX_HOOKS = 3;

/** A sourced stream that yields only whitespace still needs schema-valid,
 *  honest content — named as a model shortfall (the EMPTY_STREAM_TEXT rule
 *  applied to the draft surface). */
export const EMPTY_DRAFT_TEXT =
  "The model wrote nothing for this draft. Try again, or copy the hooks directly.";

export async function runDraft(
  request: DraftRequest,
  deps: NoteDrafterDeps,
  emit: EmitDraftEvent,
  signals: NoteDrafterSignals,
): Promise<void> {
  // Synchronous first frame — draft.started is always seq 0 (§3 siblings).
  emit({ type: "draft.started" });
  const offered = { ...request, hooks: request.hooks.slice(0, DRAFT_MAX_HOOKS) };
  try {
    if (signals.cancel.aborted) return;
    const model = deps.getModel();
    const { system, prompt } = draftNotePrompt({
      company: offered.profile.company,
      role: offered.profile.role,
      hooks: offered.hooks,
      contactName: offered.contact?.name,
    });
    let streamed = "";
    // Temperature 0, NO maxOutputTokens — the synthesis-stage rule (qwen3
    // thinking tokens would count against a ceiling and truncate output).
    const stream = model.streamSynthesis({
      system,
      prompt,
      temperature: 0,
      abortSignal: signals.cancel,
    });
    for await (const chunk of stream) {
      if (!chunk) continue;
      streamed += chunk;
      emit({ type: "draft.delta", text: chunk });
    }
    if (signals.cancel.aborted) return;
    emit({ type: "draft.completed", note: assembleDraftNote(streamed, offered) });
  } catch (err) {
    // Silent-return-on-abort, exactly like runAnalysis: the sink is dead.
    if (signals.cancel.aborted) return;
    emit(toRunErrorEvent(err));
  }
}

/** The extract()-free final assembly: canonical body, a mechanical subject
 *  (no model call — nothing to fabricate), and the grounded-hook record. */
export function assembleDraftNote(streamed: string, request: DraftRequest): DraftNote {
  const body = streamed.trim() || EMPTY_DRAFT_TEXT;
  return {
    subject: `${request.profile.role} at ${request.profile.company}`.slice(0, 150),
    body,
    groundedHooks: groundedHookTexts(body, request.hooks),
  };
}

/**
 * Which of the supplied hooks the note actually drew on. Entries are the
 * VERBATIM hook texts (never model output), so groundedHooks ⊆ supplied hook
 * texts holds by construction — the §7 subset invariant. A hook counts as
 * grounded when at least half of its significant words appear in the body:
 * the model paraphrases, so exact containment would under-report, but a hook
 * the note never touched must not be claimed (decision 16).
 */
export function groundedHookTexts(body: string, hooks: readonly Hook[]): string[] {
  const bodyWords = new Set(significantWords(body));
  const grounded: string[] = [];
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (seen.has(hook.text)) continue;
    seen.add(hook.text);
    const words = significantWords(hook.text);
    if (words.length === 0) continue;
    const matched = words.filter((word) => bodyWords.has(word)).length;
    if (matched * 2 >= words.length) grounded.push(hook.text);
  }
  return grounded;
}

function significantWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}
