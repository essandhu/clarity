import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { ZodError, type ZodType } from "zod";
import { PipelineError } from "@/domain/pipeline/errors";

// 'ai' declares ProviderOptions but does not export it; derive it from
// generateText's own options rather than reaching into a transitive package.
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

// generateText + Output.object, never generateObject (deprecated since AI SDK
// v6 — PLAN.md decision 6). The SDK's maxRetries covers retryable API errors
// only; schema-validation failure rejects with NoObjectGeneratedError, for
// which we perform exactly ONE explicit repair re-prompt (feeding back the raw
// text + the validation issues) before failing the run with EXTRACTION_FAILED.

export interface ExtractCallArgs<T> {
  model: LanguageModel;
  input: string;
  schema: ZodType<T>;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  providerOptions?: ProviderOptions;
  /** Invoked when the first attempt settles invalid — a completed generation
   *  is watchdog progress (decision 15), so the repair gets a fresh window. */
  onProgress?: () => void;
}

// Shared with streamExtract.ts (the decision-58 stream-backed variant), so
// both extract paths fail with byte-identical copy and repair prompts.
export const EXTRACTION_FAILED_HINT =
  "The model could not produce schema-valid JSON. Retry, or switch to a stronger model — the README names known-good local tags.";

export async function extractWithRepair<T>(args: ExtractCallArgs<T>): Promise<T> {
  const attempt = async (prompt: string): Promise<T> => {
    const result = await generateText({
      model: args.model,
      system: args.system,
      prompt,
      output: Output.object({ schema: args.schema }),
      temperature: args.temperature ?? 0,
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: args.abortSignal,
      providerOptions: args.providerOptions,
    });
    // Output is only parsed when the model stopped normally; on any other
    // finish reason (length, content-filter) accessing .output would throw an
    // opaque NoOutputGeneratedError. Truncation is not repairable by
    // re-prompting — fail as an honest extraction failure.
    if (result.finishReason !== "stop") {
      throw new PipelineError(
        "EXTRACTION_FAILED",
        `The model stopped before completing its structured output (finish reason: ${result.finishReason}).`,
        { hint: EXTRACTION_FAILED_HINT },
      );
    }
    return result.output;
  };

  try {
    return await attempt(args.input);
  } catch (err) {
    // Aborts and API errors are not repairable — rethrow untouched.
    if (!NoObjectGeneratedError.isInstance(err)) throw err;
    args.onProgress?.();
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

export function repairPrompt(input: string, err: NoObjectGeneratedError): string {
  return [
    input,
    "",
    "---",
    "Your previous response was rejected because it did not match the required JSON schema.",
    "Previous response:",
    err.text ?? "(empty)",
    "",
    "Validation problems:",
    describeValidationIssues(err),
    "",
    "Respond with ONLY a corrected JSON object that satisfies the schema.",
    "Do not invent values for fields you cannot find in the input; omit optional fields instead.",
  ].join("\n");
}

// The zod issues sit somewhere down the cause chain (the SDK wraps them in a
// TypeValidationError); standard-schema issue arrays are handled too.
function describeValidationIssues(err: NoObjectGeneratedError): string {
  let cause: unknown = err.cause;
  for (let depth = 0; depth < 5 && cause !== null && cause !== undefined; depth++) {
    if (cause instanceof ZodError) return JSON.stringify(cause.issues);
    if (typeof cause === "object" && "issues" in cause) {
      const issues = (cause as { issues: unknown }).issues;
      if (Array.isArray(issues)) return JSON.stringify(issues);
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return err.message;
}
