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
import type { GithubImporter } from "@/providers/import/GithubImporter";
import { GithubEtagCache } from "@/providers/import/githubEtagCache";
import { RestGithubImporter } from "@/providers/import/RestGithubImporter";
import type { LatexCompiler } from "@/providers/latex/LatexCompiler";
import { TectonicCompiler } from "@/providers/latex/TectonicCompiler";
import { JsonFileProfileStore } from "@/providers/profile/JsonFileProfileStore";
import type { ProfileStore } from "@/providers/profile/ProfileStore";

// The composition root (PLAN.md §4): the ONE place env is read — provider
// selection (via describeModelSelection, so the health chip, run.started and
// the actual provider can never disagree), OLLAMA_BASE_URL, and the budget
// knobs. Route handlers import only this + domain + schema.

export const HEALTH_PING_TIMEOUT_MS = 2_000;

// data/cache/pages under apps/web (increment 9) — inside the gitignored
// data/ dir; the cache creates it lazily on the first write. cwd is apps/web
// for every `next dev`/`next start` invocation (PLAN.md §2 tree).
export const PAGE_CACHE_DIR = path.join(process.cwd(), "data", "cache", "pages");

// data/profile under apps/web (increment 11) — the master profile's home,
// inside the same gitignored data/ net (cwd-anchored like PAGE_CACHE_DIR,
// covered by the root /data/ safety pin).
export const PROFILE_DIR = path.join(process.cwd(), "data", "profile");

// data/github under apps/web (increment 12) — the GitHub ETag/body cache,
// same gitignored data/ net (decision 44's 24h zero-quota re-imports).
export const GITHUB_CACHE_DIR = path.join(process.cwd(), "data", "github");

// data/tectonic/warmed.json under apps/web (increment 15) — the bundle-warmed
// marker (decision 51); same gitignored data/ net. Its presence flips every
// compile to --only-cached so a routine compile never re-opens the CDN.
export const TECTONIC_WARMED_PATH = path.join(process.cwd(), "data", "tectonic", "warmed.json");

// TECTONIC_PATH is read HERE and nowhere else (§4.10). The compiler is
// consumed only by the render route + the health probe (a local binary spawn,
// never a network dial — decision 56).
function buildLatexCompiler(env: ModelEnv): LatexCompiler {
  return new TectonicCompiler({ tectonicPath: env.TECTONIC_PATH, warmedPath: TECTONIC_WARMED_PATH });
}

export interface ServerDeps {
  pipeline: PipelineDeps;
  selection: ModelSelection;
  profileStore: ProfileStore;
  githubImporter: GithubImporter;
  latexCompiler: LatexCompiler;
}

export function buildServerDeps(env: ModelEnv = process.env): ServerDeps {
  const selection = describeModelSelection(env);
  return {
    selection,
    profileStore: new JsonFileProfileStore(PROFILE_DIR),
    latexCompiler: buildLatexCompiler(env),
    // GITHUB_TOKEN is read HERE and nowhere else (§4.10); it travels only
    // into the Authorization header (decision 56).
    githubImporter: new RestGithubImporter({
      cache: new GithubEtagCache(GITHUB_CACHE_DIR),
      token: env.GITHUB_TOKEN,
    }),
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
  // STATIC env presence only (decision 56): an automatic health poll must
  // never dial api.github.com — live rate info arrives only inside the
  // user-initiated stage-A import response.
  github: { tokenConfigured: boolean };
  // A LOCAL binary probe (decision 56): resolved availability + parsed version
  // + whether the bundle CDN is already warmed. Never a network dial.
  tectonic: { available: boolean; version?: string; warmed: boolean };
}

/**
 * GET /api/health payload (§3 sibling routes). Never leaks keys: the payload
 * carries only the provider id, the constant model id, and — for Ollama — a
 * reachability ping against the CONFIGURED base URL read through this same
 * composition root, so a non-default host/port never yields a false
 * "unreachable" chip (decision 26). The `latexCompiler` seam is injected so
 * tests never spawn a real binary.
 */
export async function describeHealth(
  env: ModelEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  latexCompiler: LatexCompiler = buildLatexCompiler(env),
): Promise<HealthPayload> {
  const github = { tokenConfigured: Boolean(env.GITHUB_TOKEN?.trim()) };
  const tectonic = await latexCompiler.probe();
  const selection = describeModelSelection(env);
  if (selection.id === "unconfigured") return { provider: { id: "unconfigured" }, github, tectonic };
  // Selected but unconstructible (e.g. MODEL_PROVIDER=openai with no key) is
  // "unconfigured" as far as the chip is concerned — a run would fail fast.
  try {
    createModelProvider(env);
  } catch (err) {
    if (isPipelineError(err)) return { provider: { id: "unconfigured" }, github, tectonic };
    throw err;
  }
  if (selection.id === "ollama") {
    return {
      provider: {
        id: "ollama",
        model: selection.modelId,
        reachable: await pingOllama(selection.baseUrl, fetchImpl),
      },
      github,
      tectonic,
    };
  }
  return { provider: { id: selection.id, model: selection.modelId }, github, tectonic };
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
