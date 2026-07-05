import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
import type { ZodType } from "zod";
import { PipelineError } from "@/domain/pipeline/errors";
import { extractWithRepair, type ProviderOptions } from "./extractWithRepair";
import {
  callWithWatchdog,
  DEFAULT_INACTIVITY_MS,
  streamWithWatchdog,
} from "./inactivityWatchdog";
import type { GenOpts, ModelProvider, SynthesisPrompt } from "./ModelProvider";
import { stripThinkStream } from "./thinkStrip";

import { describeModelSelection, type ModelEnv } from "./modelSelection";

// Selection (pure) lives in modelSelection.ts; re-exported so existing
// callers and tests keep one import site for the whole seam.
export * from "./modelSelection";

const CONFIGURE_HINT =
  "Set OPENAI_API_KEY or ANTHROPIC_API_KEY in apps/web/.env.local, or run Ollama locally and set MODEL_PROVIDER=ollama.";

/**
 * Env switch per PLAN.md §4.1 (selection rules in describeModelSelection).
 * deps.ts (increment 5) is the single in-app caller, passing its one env
 * read down here.
 */
export function createModelProvider(env: ModelEnv = process.env): ModelProvider {
  const inactivityMs = parsePositiveInt(env.CLARITY_MODEL_INACTIVITY_MS) ?? DEFAULT_INACTIVITY_MS;
  const selection = describeModelSelection(env);
  switch (selection.id) {
    case "openai": {
      requireKey(env.OPENAI_API_KEY, "openai", "OPENAI_API_KEY");
      const model = createOpenAI({ apiKey: env.OPENAI_API_KEY })(selection.modelId);
      // AI SDK 6+ defaults strict JSON schema mode ON, which rejects zod
      // .optional() fields; this option keeps the §5 schemas canonical
      // (PLAN.md decision 9). Extraction calls only.
      return buildProvider({
        id: "openai",
        model,
        inactivityMs,
        extractProviderOptions: { openai: { strictJsonSchema: false } },
      });
    }
    case "anthropic": {
      requireKey(env.ANTHROPIC_API_KEY, "anthropic", "ANTHROPIC_API_KEY");
      const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(selection.modelId);
      return buildProvider({ id: "anthropic", model, inactivityMs });
    }
    case "ollama": {
      const modelId = selection.modelId;
      // ai-sdk-ollama reads NO env vars itself — OLLAMA_BASE_URL is honored here.
      const ollama = createOllama({ baseURL: selection.baseUrl });
      // Both instances: the package's default "reliability" layer re-prompts
      // up to 3 times and can fabricate fallback values on failure — both
      // conflict with the single explicit repair re-prompt (decision 6) and
      // the never-fabricates rule (decision 16). extractWithRepair owns repair.
      const extractModel = ollama(modelId, {
        // Extraction disables qwen3 thinking (decision 30): with
        // schema-constrained decoding the grammar keeps any residual inline
        // reasoning out of the JSON and no thinking tokens are burned. Gated
        // to the qwen3 family proper ("qwen3", "qwen3:4b"): Ollama rejects
        // the think param on models without the capability (qwen3-coder incl).
        ...(/^qwen3(:|$)/i.test(modelId) ? { think: false as const } : {}),
        reliableObjectGeneration: false,
      });
      // Synthesis deliberately does NOT set think: on 2026 qwen3 builds
      // think:false backfires for free-form text — the model reasons INLINE
      // in message.content where no tag-stripper can catch it (verified live
      // 2026-07-04 against Ollama 0.31.1). Left at the default, Ollama
      // separates reasoning into message.thinking, which ai-sdk-ollama keeps
      // out of textStream entirely.
      const synthesisModel = ollama(modelId, { reliableObjectGeneration: false });
      return buildProvider({ id: "ollama", model: extractModel, synthesisModel, inactivityMs });
    }
    case "unconfigured":
      if (selection.requested !== undefined) {
        throw new PipelineError(
          "MODEL_UNCONFIGURED",
          `Unknown MODEL_PROVIDER "${selection.requested}" — expected openai, anthropic, or ollama.`,
          { hint: CONFIGURE_HINT },
        );
      }
      throw new PipelineError("MODEL_UNCONFIGURED", "No model provider is configured.", {
        hint: CONFIGURE_HINT,
      });
    default:
      return selection satisfies never;
  }
}

function requireKey(key: string | undefined, provider: string, envVar: string): void {
  if (!key) {
    throw new PipelineError(
      "MODEL_UNCONFIGURED",
      `MODEL_PROVIDER=${provider} is set but ${envVar} is missing.`,
      { hint: CONFIGURE_HINT },
    );
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildProvider(args: {
  id: string;
  model: LanguageModel;
  /** Distinct synthesis instance when construction knobs differ (Ollama). */
  synthesisModel?: LanguageModel;
  inactivityMs: number;
  extractProviderOptions?: ProviderOptions;
}): ModelProvider {
  const { id, model, inactivityMs, extractProviderOptions } = args;
  const synthesisModel = args.synthesisModel ?? model;
  return {
    id,
    extract<T>(input: string, schema: ZodType<T>, opts?: GenOpts): Promise<T> {
      return callWithWatchdog(
        { inactivityMs, abortSignal: opts?.abortSignal },
        (signal, progress) =>
          extractWithRepair({
            model,
            input,
            schema,
            system: opts?.system,
            temperature: opts?.temperature ?? 0,
            maxOutputTokens: opts?.maxOutputTokens,
            abortSignal: signal,
            providerOptions: extractProviderOptions,
            onProgress: progress,
          }),
      );
    },
    streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string> {
      // The watchdog wraps the RAW stream so progress counts every model
      // chunk — a model working through a long literal <think> block is
      // progressing, not stalling. Stripping happens downstream.
      return stripThinkStream(
        streamWithWatchdog({ inactivityMs, abortSignal: prompt.abortSignal }, (signal) =>
          synthesisStream(synthesisModel, prompt, signal),
        ),
      );
    },
  };
}

async function* synthesisStream(
  model: LanguageModel,
  prompt: SynthesisPrompt,
  signal: AbortSignal,
): AsyncIterable<string> {
  const { textStream } = streamText({
    model,
    system: prompt.system,
    prompt: prompt.prompt,
    temperature: prompt.temperature,
    maxOutputTokens: prompt.maxOutputTokens,
    abortSignal: signal,
  });
  // In AI SDK v7 textStream throws on stream errors — nothing is swallowed.
  yield* textStream;
}
