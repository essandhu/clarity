import { NoObjectGeneratedError, Output, streamText } from "ai";
import { PipelineError } from "@/domain/pipeline/errors";
import {
  EXTRACTION_FAILED_HINT,
  repairPrompt,
  type ExtractCallArgs,
} from "./extractWithRepair";

// The decision-58 stream-backed extract (PLAN-RESUME.md §4.3 / risk 21):
// identical contract to extractWithRepair — schema-validated result, one
// repair re-prompt on validation failure, EXTRACTION_FAILED after — but the
// generation is CONSUMED as a stream so every delta (text or separated
// reasoning) pings onDelta, which the provider wires to the watchdog's
// progress reset. A healthy slow-CPU extraction can then run past the
// inactivity window as long as tokens keep arriving; a genuinely hung stream
// still dies (no deltas ⇒ no progress ⇒ the watchdog fires). This is the
// increment-7 fullStream lesson applied to extraction.

export interface StreamExtractArgs<T> extends ExtractCallArgs<T> {
  /** Invoked on EVERY model delta — the watchdog's progress feed. */
  onDelta?: () => void;
}

export async function streamExtractWithRepair<T>(args: StreamExtractArgs<T>): Promise<T> {
  const attempt = async (prompt: string): Promise<T> => {
    const result = streamText({
      model: args.model,
      system: args.system,
      prompt,
      output: Output.object({ schema: args.schema }),
      temperature: args.temperature ?? 0,
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: args.abortSignal,
      providerOptions: args.providerOptions,
    });
    // Pre-observe: when the stream errors mid-flight, these settle rejected
    // AFTER the loop below has already thrown — never an unhandled rejection.
    const output = Promise.resolve(result.output);
    output.catch(() => {});
    const finishReason = Promise.resolve(result.finishReason);
    finishReason.catch(() => {});

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
        case "reasoning-delta":
          args.onDelta?.();
          break;
        case "error":
          // fullStream delivers provider errors as parts; rethrow so nothing
          // is swallowed (the synthesisStream rule).
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        case "abort":
          throw toAbortError(args.abortSignal?.reason);
        default:
          break;
      }
    }

    // Truncation (length, content-filter) is not repairable by re-prompting —
    // the extractWithRepair rule, verbatim.
    const finish = await finishReason;
    if (finish !== "stop") {
      throw new PipelineError(
        "EXTRACTION_FAILED",
        `The model stopped before completing its structured output (finish reason: ${finish}).`,
        { hint: EXTRACTION_FAILED_HINT },
      );
    }
    // Rejects with NoObjectGeneratedError when the streamed text failed
    // schema validation — the repair trigger, same class as the promise path.
    return (await output) as T;
  };

  try {
    return await attempt(args.input);
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err;
    args.onProgress?.(); // a completed-but-invalid generation is progress
    try {
      return await attempt(repairPrompt(args.input, err));
    } catch (repairErr) {
      if (!NoObjectGeneratedError.isInstance(repairErr)) throw repairErr;
      throw new PipelineError(
        "EXTRACTION_FAILED",
        "The model could not produce output matching the expected schema, even after a repair re-prompt.",
        { hint: EXTRACTION_FAILED_HINT, cause: repairErr },
      );
    }
  }
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The extraction stream was aborted.", "AbortError");
}
