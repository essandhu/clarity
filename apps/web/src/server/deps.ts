import path from "node:path";
import type { PipelineDeps } from "@/domain/pipeline/AnalysisPipeline";
import { systemClock } from "@/domain/pipeline/clock";
import { isPipelineError } from "@/domain/pipeline/errors";
import { JsonFilePageCache } from "@/providers/cache/JsonFilePageCache";
import { RobotsAwarePageFetcher } from "@/providers/fetch/RobotsAwarePageFetcher";
import {
  createModelProvider,
  describeModelSelection,
  type ModelEnv,
  type ModelSelection,
} from "@/providers/model/createModelProvider";

// The composition root (PLAN.md §4): the ONE place env is read — provider
// selection (via describeModelSelection, so the health chip, run.started and
// the actual provider can never disagree), OLLAMA_BASE_URL, and the budget
// knobs. Route handlers import only this + domain + schema.

export const HEALTH_PING_TIMEOUT_MS = 2_000;

// data/cache/pages under apps/web (increment 9) — inside the gitignored
// data/ dir; the cache creates it lazily on the first write. cwd is apps/web
// for every `next dev`/`next start` invocation (PLAN.md §2 tree).
export const PAGE_CACHE_DIR = path.join(process.cwd(), "data", "cache", "pages");

export interface ServerDeps {
  pipeline: PipelineDeps;
  selection: ModelSelection;
}

export function buildServerDeps(env: ModelEnv = process.env): ServerDeps {
  const selection = describeModelSelection(env);
  return {
    selection,
    pipeline: {
      providerId: selection.id,
      // Lazy: a misconfigured provider must surface as run.error ON the
      // stream (after run.started), not as a route crash. Construction is
      // cheap and stateless — all the durable state (robots cache, limiters,
      // breakers) already lives on globalThis inside the fetcher modules.
      getModel: () => createModelProvider(env),
      fetcher: new RobotsAwarePageFetcher(fetch, new JsonFilePageCache(PAGE_CACHE_DIR)),
      clock: systemClock,
      budget: {
        // Raw values; clampBudgetConfig (defaults + ceilings) is applied by
        // the pipeline so run.started reports exactly what is enforced.
        maxFetches: Number.parseInt(env.CLARITY_MAX_FETCHES ?? "", 10),
        deadlineMs: Number.parseInt(env.CLARITY_DEADLINE_MS ?? "", 10),
      },
      // The route adapter's real deadline timer (decision 22: the domain owns
      // no timers; it calls this seam and disposes it in its finally).
      scheduleDeadline: (fire, afterMs) => {
        const timer = setTimeout(fire, afterMs);
        return () => clearTimeout(timer);
      },
    },
  };
}

export interface HealthPayload {
  provider: {
    id: "openai" | "anthropic" | "ollama" | "unconfigured";
    model?: string;
    reachable?: boolean;
  };
}

/**
 * GET /api/health payload (§3 sibling routes). Never leaks keys: the payload
 * carries only the provider id, the constant model id, and — for Ollama — a
 * reachability ping against the CONFIGURED base URL read through this same
 * composition root, so a non-default host/port never yields a false
 * "unreachable" chip (decision 26).
 */
export async function describeHealth(
  env: ModelEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthPayload> {
  const selection = describeModelSelection(env);
  if (selection.id === "unconfigured") return { provider: { id: "unconfigured" } };
  // Selected but unconstructible (e.g. MODEL_PROVIDER=openai with no key) is
  // "unconfigured" as far as the chip is concerned — a run would fail fast.
  try {
    createModelProvider(env);
  } catch (err) {
    if (isPipelineError(err)) return { provider: { id: "unconfigured" } };
    throw err;
  }
  if (selection.id === "ollama") {
    return {
      provider: {
        id: "ollama",
        model: selection.modelId,
        reachable: await pingOllama(selection.baseUrl, fetchImpl),
      },
    };
  }
  return { provider: { id: selection.id, model: selection.modelId } };
}

async function pingOllama(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(new URL("/api/version", baseUrl).toString(), {
      signal: AbortSignal.timeout(HEALTH_PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
