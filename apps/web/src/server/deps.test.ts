import { describe, expect, it, vi } from "vitest";
import { describeModelSelection } from "@/providers/model/createModelProvider";
import { buildServerDeps, describeHealth } from "./deps";

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
  it("reports unconfigured for an empty env", async () => {
    expect(await describeHealth({})).toEqual({ provider: { id: "unconfigured" } });
  });

  it("reports a constructible cloud provider with its constant model id", async () => {
    expect(await describeHealth({ ANTHROPIC_API_KEY: "sk-y" })).toEqual({
      provider: { id: "anthropic", model: "claude-sonnet-5" },
    });
  });

  it("a selected-but-keyless provider is unconfigured, never a crash", async () => {
    expect(await describeHealth({ MODEL_PROVIDER: "openai" })).toEqual({
      provider: { id: "unconfigured" },
    });
  });

  it("pings the CONFIGURED Ollama base URL (decision 26) and reports reachable", async () => {
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    const health = await describeHealth(
      { MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://localhost:11435" },
      fetchStub as unknown as typeof fetch,
    );
    expect(health).toEqual({
      provider: { id: "ollama", model: "qwen3:4b", reachable: true },
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
      (await describeHealth({ MODEL_PROVIDER: "ollama" }, rejecting as unknown as typeof fetch))
        .provider.reachable,
    ).toBe(false);

    const errorStatus = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(
      (await describeHealth({ MODEL_PROVIDER: "ollama" }, errorStatus as unknown as typeof fetch))
        .provider.reachable,
    ).toBe(false);
  });
});
