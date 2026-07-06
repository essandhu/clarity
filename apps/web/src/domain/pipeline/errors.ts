import type { PipelineEvent, RunErrorCode } from "@/shared/schema";

export type { RunErrorCode };

// The ONLY throwable that may terminate a run (PLAN.md decision 21). Skips are
// data (FetchSkip), never thrown. Only Stage 1, model configuration, and the
// inactivity watchdog raise one; Stages 2–3 are structurally incapable of
// killing a run.
export class PipelineError extends Error {
  readonly code: RunErrorCode;
  readonly hint?: string;
  readonly stage?: string;

  constructor(
    code: RunErrorCode,
    message: string,
    opts?: { hint?: string; stage?: string; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PipelineError";
    this.code = code;
    this.hint = opts?.hint;
    this.stage = opts?.stage;
  }
}

export function isPipelineError(err: unknown): err is PipelineError {
  return err instanceof PipelineError;
}

/** The one thrown-error → run.error mapping, shared by every streamed run
 *  (the analysis pipeline and increment 8's draft): a PipelineError keeps its
 *  code/hint/stage; anything else is an honest INTERNAL. */
export function toRunErrorEvent(err: unknown): Extract<PipelineEvent, { type: "run.error" }> {
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

// Cancellation (user abort, deadline) is signalled with AbortError-shaped
// values by fetch and the AI SDK; it must never be mistaken for a fatal
// PipelineError. DOMException is not an Error subclass everywhere, so this
// checks the name, not the prototype chain.
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}
