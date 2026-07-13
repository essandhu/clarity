import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonFilePageCache } from "@/providers/cache/JsonFilePageCache";
import { GithubEtagCache } from "@/providers/import/githubEtagCache";
import { RestGithubImporter } from "@/providers/import/RestGithubImporter";
import type { LatexCompiler, LatexProbe } from "@/providers/latex/LatexCompiler";
import { TectonicCompiler } from "@/providers/latex/TectonicCompiler";
import { describeModelSelection } from "@/providers/model/createModelProvider";
import { JsonFileProfileStore } from "@/providers/profile/JsonFileProfileStore";
import type { CleanPage } from "@/shared/schema";
import {
  buildServerDeps,
  describeHealth,
  GITHUB_CACHE_DIR,
  PAGE_CACHE_DIR,
  PROFILE_DIR,
  TECTONIC_WARMED_PATH,
} from "./deps";

// A no-spawn compiler for the health tests — the real probe would fork a
// binary; describeHealth's tectonic seam is injected exactly so it never does.
const OFFLINE_TECTONIC: LatexProbe = { available: false, warmed: false };
function stubCompiler(probe: LatexProbe): LatexCompiler {
  return { probe: async () => probe, compile: async () => ({ kind: "unavailable" }) };
}

// The composition root: selection, knob parsing, and the health payload all
// read the SAME env snapshot — these tests pin that they can't disagree.

describe("describeModelSelection", () => {
  it("explicit MODEL_PROVIDER wins over present keys", () => {
    expect(
      describeModelSelection({ MODEL_PROVIDER: "ollama", OPENAI_API_KEY: "sk-x" }),
    ).toMatchObject({ id: "ollama" });
  });

  it("auto-detects openai first, then anthropic, from present keys", () => {
    expect(
      describeModelSelection({ OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" }),
    ).toMatchObject({ id: "openai" });
    expect(describeModelSelection({ ANTHROPIC_API_KEY: "sk-y" })).toMatchObject({
      id: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("a blank MODEL_PROVIDER= line does not defeat auto-detection", () => {
    expect(describeModelSelection({ MODEL_PROVIDER: "  ", OPENAI_API_KEY: "sk-x" })).toMatchObject({
      id: "openai",
    });
  });

  it("ollama selection carries the configured base URL and model tag", () => {
    expect(
      describeModelSelection({
        MODEL_PROVIDER: "ollama",
        OLLAMA_BASE_URL: "http://localhost:11435",
        OLLAMA_MODEL: "llama3.2:3b",
      }),
    ).toEqual({ id: "ollama", modelId: "llama3.2:3b", baseUrl: "http://localhost:11435" });
    expect(describeModelSelection({ MODEL_PROVIDER: "ollama" })).toEqual({
      id: "ollama",
      modelId: "qwen3:4b",
      baseUrl: "http://localhost:11434",
    });
  });

  it("empty env and unknown providers are unconfigured", () => {
    expect(describeModelSelection({})).toEqual({ id: "unconfigured" });
    expect(describeModelSelection({ MODEL_PROVIDER: "gemini" })).toEqual({
      id: "unconfigured",
      requested: "gemini",
    });
  });
});

describe("buildServerDeps", () => {
  it("threads selection into providerId and parses the budget knobs", () => {
    const deps = buildServerDeps({
      MODEL_PROVIDER: "ollama",
      CLARITY_MAX_FETCHES: "5",
      CLARITY_DEADLINE_MS: "30000",
    });
    expect(deps.pipeline.providerId).toBe("ollama");
    expect(deps.pipeline.budget).toEqual({ maxFetches: 5, deadlineMs: 30_000 });
  });

  it("missing knobs come through as NaN for the pipeline's clamp to default", () => {
    const deps = buildServerDeps({});
    expect(Number.isNaN(deps.pipeline.budget.maxFetches)).toBe(true);
    expect(Number.isNaN(deps.pipeline.budget.deadlineMs)).toBe(true);
    expect(deps.pipeline.providerId).toBe("unconfigured");
  });

  describe("page-cache wiring (increment 9 review finding)", () => {
    // A unique per-run sentinel URL: the shared PAGE_CACHE_DIR may hold real
    // cached pages, and parallel test runs must not collide.
    const sentinelUrl = `https://deps-wiring.test/${process.pid}-${Math.random().toString(36).slice(2)}`;
    const sentinelFile = path.join(
      PAGE_CACHE_DIR,
      `${createHash("sha256").update(sentinelUrl).digest("hex")}.json`,
    );
    const sentinel: CleanPage = {
      kind: "page",
      url: sentinelUrl,
      finalUrl: sentinelUrl,
      title: "Wiring sentinel",
      text: "Proves buildServerDeps wires JsonFilePageCache into the fetcher.",
      fetchedAt: new Date().toISOString(),
    };
    afterEach(async () => {
      await rm(sentinelFile, { force: true });
    });

    it("the built fetcher reads the production cache dir — a cacheless revert fails here", async () => {
      // Seed through a JsonFilePageCache aimed at the SAME production dir;
      // the composition root's fetcher must see it. This is the pin:
      // `new RobotsAwarePageFetcher()` (no cache) still exposes cached(),
      // but it would return null here and the whole increment would be
      // silently unwired in production (mutation-verified by the review).
      await new JsonFilePageCache(PAGE_CACHE_DIR).set(sentinel);
      const deps = buildServerDeps({});
      await expect(deps.pipeline.fetcher.cached?.(sentinelUrl)).resolves.toEqual(sentinel);
    });
  });

  describe("profile-store wiring (increment 11; the increment-9 sentinel lesson)", () => {
    // The page-cache pin writes a unique per-run sentinel FILE — safe because
    // every URL gets its own name. The profile store has exactly ONE file
    // (data/profile/master.json), so a write-sentinel here would clobber a
    // real user profile on every test run. The pin is therefore structural
    // (real store class, aimed at the real PROFILE_DIR — TS-private fields
    // are runtime-visible) plus behavioral-read-only; the increment-11 live
    // driver's PUT→GET round-trip is the destructive-write proof, run against
    // a server whose data/ is expected to change.
    it("wires a JsonFileProfileStore aimed at the production PROFILE_DIR", async () => {
      const deps = buildServerDeps({});
      expect(PROFILE_DIR).toBe(path.join(process.cwd(), "data", "profile"));
      expect(deps.profileStore).toBeInstanceOf(JsonFileProfileStore);
      expect((deps.profileStore as unknown as { dir: string }).dir).toBe(PROFILE_DIR);
      // Read-only behavioral check against the real dir: any honest state is
      // acceptable; a mis-wired store would still resolve, but the dir pin
      // above has already nailed the path.
      const loaded = await deps.profileStore.load();
      expect(["ok", "empty", "unreadable"]).toContain(loaded.kind);
    });
  });

  describe("github-importer wiring (increment 12; the increment-9 sentinel lesson)", () => {
    // Structural pin, the profile-store shape: the importer writes only
    // per-URL cache files, but the LIVE driver owns the behavioral half
    // (a warm re-run served from data/github/ with zero quota spent), so
    // this test stays read-only against the real dirs. TS-private fields
    // are runtime-visible.
    it("wires a RestGithubImporter over a GithubEtagCache aimed at GITHUB_CACHE_DIR, threading GITHUB_TOKEN", () => {
      const deps = buildServerDeps({ GITHUB_TOKEN: "ghp_wiring-pin" });
      expect(GITHUB_CACHE_DIR).toBe(path.join(process.cwd(), "data", "github"));
      expect(deps.githubImporter).toBeInstanceOf(RestGithubImporter);
      const internals = deps.githubImporter as unknown as {
        deps: { cache: unknown; token?: string };
      };
      expect(internals.deps.cache).toBeInstanceOf(GithubEtagCache);
      expect((internals.deps.cache as unknown as { dir: string }).dir).toBe(GITHUB_CACHE_DIR);
      expect(internals.deps.token).toBe("ghp_wiring-pin");

      const keyless = buildServerDeps({});
      expect((keyless.githubImporter as unknown as { deps: { token?: string } }).deps.token).toBeUndefined();
    });
  });

  describe("latex-compiler wiring (increment 15; the increment-9 sentinel lesson)", () => {
    // Structural pin (the profile-store/github shapes): TS-private fields are
    // runtime-visible, and the live --render-pdf driver owns the behavioral
    // half (a real cold+warm compile against the installed binary).
    it("wires a TectonicCompiler at TECTONIC_WARMED_PATH, threading TECTONIC_PATH", () => {
      const deps = buildServerDeps({ TECTONIC_PATH: "C:/bin/tectonic.exe" });
      expect(TECTONIC_WARMED_PATH).toBe(path.join(process.cwd(), "data", "tectonic", "warmed.json"));
      expect(deps.latexCompiler).toBeInstanceOf(TectonicCompiler);
      const internals = deps.latexCompiler as unknown as { tectonicPath?: string; warmedPath: string };
      expect(internals.tectonicPath).toBe("C:/bin/tectonic.exe");
      expect(internals.warmedPath).toBe(TECTONIC_WARMED_PATH);

      const keyless = buildServerDeps({});
      expect((keyless.latexCompiler as unknown as { tectonicPath?: string }).tectonicPath).toBeUndefined();
    });
  });

  it("scheduleDeadline arms a real timer and the disposer cancels it", () => {
    vi.useFakeTimers();
    try {
      const deps = buildServerDeps({});
      const fire = vi.fn();
      const dispose = deps.pipeline.scheduleDeadline!(fire, 1_000);
      vi.advanceTimersByTime(999);
      expect(fire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fire).toHaveBeenCalledTimes(1);

      const fire2 = vi.fn();
      const dispose2 = deps.pipeline.scheduleDeadline!(fire2, 1_000);
      dispose2();
      vi.advanceTimersByTime(2_000);
      expect(fire2).not.toHaveBeenCalled();
      dispose(); // disposing after fire is a no-op
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeHealth", () => {
  const noToken = { tokenConfigured: false };
  const offline = stubCompiler(OFFLINE_TECTONIC);

  it("reports unconfigured for an empty env", async () => {
    expect(await describeHealth({}, undefined, offline)).toEqual({
      provider: { id: "unconfigured" },
      github: noToken,
      tectonic: OFFLINE_TECTONIC,
    });
  });

  it("reports a constructible cloud provider with its constant model id", async () => {
    expect(await describeHealth({ ANTHROPIC_API_KEY: "sk-y" }, undefined, offline)).toEqual({
      provider: { id: "anthropic", model: "claude-sonnet-5" },
      github: noToken,
      tectonic: OFFLINE_TECTONIC,
    });
  });

  it("a selected-but-keyless provider is unconfigured, never a crash", async () => {
    expect(await describeHealth({ MODEL_PROVIDER: "openai" }, undefined, offline)).toEqual({
      provider: { id: "unconfigured" },
      github: noToken,
      tectonic: OFFLINE_TECTONIC,
    });
  });

  it("pings the CONFIGURED Ollama base URL (decision 26) and reports reachable", async () => {
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    const health = await describeHealth(
      { MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://localhost:11435" },
      fetchStub as unknown as typeof fetch,
      offline,
    );
    expect(health).toEqual({
      provider: { id: "ollama", model: "qwen3:4b", reachable: true },
      github: noToken,
      tectonic: OFFLINE_TECTONIC,
    });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://localhost:11435/api/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("an unreachable or erroring Ollama reports reachable: false", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      (await describeHealth({ MODEL_PROVIDER: "ollama" }, rejecting as unknown as typeof fetch, offline))
        .provider.reachable,
    ).toBe(false);

    const errorStatus = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(
      (await describeHealth({ MODEL_PROVIDER: "ollama" }, errorStatus as unknown as typeof fetch, offline))
        .provider.reachable,
    ).toBe(false);
  });

  it("github.tokenConfigured is STATIC env presence — health never dials GitHub (decision 56)", async () => {
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    const withToken = await describeHealth(
      { ANTHROPIC_API_KEY: "sk-y", GITHUB_TOKEN: "ghp_x" },
      fetchStub as unknown as typeof fetch,
      offline,
    );
    expect(withToken.github).toEqual({ tokenConfigured: true });
    expect(fetchStub).not.toHaveBeenCalled(); // zero dials of any kind

    const blankToken = await describeHealth(
      { ANTHROPIC_API_KEY: "sk-y", GITHUB_TOKEN: "   " },
      fetchStub as unknown as typeof fetch,
      offline,
    );
    expect(blankToken.github).toEqual({ tokenConfigured: false }); // a blank env line is not a token
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("carries the tectonic probe result verbatim (decision 50, a LOCAL probe)", async () => {
    const available = stubCompiler({ available: true, version: "0.16.9", warmed: true });
    expect((await describeHealth({}, undefined, available)).tectonic).toEqual({
      available: true,
      version: "0.16.9",
      warmed: true,
    });

    const missing = stubCompiler({ available: false, warmed: false });
    expect((await describeHealth({ ANTHROPIC_API_KEY: "sk-y" }, undefined, missing)).tectonic).toEqual({
      available: false,
      warmed: false,
    });
  });

  it("probes tectonic even when the model provider is unconfigured", async () => {
    // A never-called fetch stub proves no dial; the tectonic seam still runs.
    const fetchStub = vi.fn();
    const warm = stubCompiler({ available: true, version: "0.16.9", warmed: false });
    const health = await describeHealth({}, fetchStub as unknown as typeof fetch, warm);
    expect(health.tectonic).toEqual({ available: true, version: "0.16.9", warmed: false });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("the DEFAULT (uninjected) tectonic seam is the real compiler — a missing binary path is unavailable, no spawn", async () => {
    // The /api/health route calls describeHealth() with no compiler arg, so the
    // default `buildLatexCompiler(env)` drives the chip. Pointing TECTONIC_PATH
    // at a nonexistent binary makes the real TectonicCompiler resolve to null and
    // report unavailable WITHOUT spawning — deterministic, no binary needed. This
    // pins that the health route runs the real probe path (not a hardcoded stub).
    const health = await describeHealth({ TECTONIC_PATH: "/no/such/tectonic-binary-xyz" });
    expect(health.tectonic.available).toBe(false);
    expect(typeof health.tectonic.warmed).toBe("boolean");
  });
});
