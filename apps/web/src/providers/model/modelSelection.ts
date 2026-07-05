// The pure selection half of the provider env switch, split from
// createModelProvider.ts (~200-line ceiling). Answering "which provider WOULD
// run?" needs no construction: run.started's provider id, the /api/health
// chip, and the Ollama ping target all read THIS, so they can never disagree
// with what createModelProvider actually builds.

// Cloud model ids are constants, not env knobs — .env.example deliberately
// exposes only provider selection plus Ollama tuning (PLAN.md §2 file tree).
export const OPENAI_MODEL_ID = "gpt-5-mini";
export const ANTHROPIC_MODEL_ID = "claude-sonnet-5";
export const DEFAULT_OLLAMA_MODEL_ID = "qwen3:4b";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

// Recognized keys: MODEL_PROVIDER, OPENAI_API_KEY, ANTHROPIC_API_KEY,
// OLLAMA_BASE_URL, OLLAMA_MODEL, CLARITY_MODEL_INACTIVITY_MS. Typed as a plain
// record so process.env satisfies it directly.
export type ModelEnv = Record<string, string | undefined>;

export type ModelSelection =
  | { id: "openai" | "anthropic"; modelId: string }
  | { id: "ollama"; modelId: string; baseUrl: string }
  | { id: "unconfigured"; requested?: string };

/**
 * Selection per PLAN.md §4.1: explicit MODEL_PROVIDER wins; otherwise
 * auto-detect from present keys (openai, then anthropic). Ollama has no key,
 * so it is only ever selected explicitly.
 */
export function describeModelSelection(env: ModelEnv = process.env): ModelSelection {
  // A blank MODEL_PROVIDER= line (as shipped commented-out-or-empty in
  // .env.example) must not defeat key auto-detection.
  const explicit = env.MODEL_PROVIDER?.trim();
  const selected = explicit ? explicit : autoDetect(env);
  switch (selected) {
    case "openai":
      return { id: "openai", modelId: OPENAI_MODEL_ID };
    case "anthropic":
      return { id: "anthropic", modelId: ANTHROPIC_MODEL_ID };
    case "ollama":
      return {
        id: "ollama",
        modelId: env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL_ID,
        baseUrl: env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      };
    case undefined:
      return { id: "unconfigured" };
    default:
      return { id: "unconfigured", requested: selected };
  }
}

function autoDetect(env: ModelEnv): "openai" | "anthropic" | undefined {
  if (env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return undefined;
}
