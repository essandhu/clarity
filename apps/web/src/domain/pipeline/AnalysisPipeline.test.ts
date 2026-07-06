import { describe, expect, it, vi } from "vitest";
import {
  extraction,
  page,
  stubFetcher,
  stubModel,
} from "@/domain/listing/extractorTestKit";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import { PipelineEventSchema, type AnalyzeInput, type PipelineEvent } from "@/shared/schema";
import { runAnalysis, type PipelineDeps } from "./AnalysisPipeline";
import { PipelineError } from "./errors";

// Every emitted event is parsed through the wire schema, so a pipeline that
// emits anything the protocol can't carry fails HERE, not in a browser.

const TEXT_INPUT: AnalyzeInput = {
  kind: "text",
  text: "Driftlock is hiring a Backend Engineer to work on data pipelines in Go.",
};
const URL_INPUT: AnalyzeInput = { kind: "url", url: page.url };

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    providerId: "stub",
    getModel: () => stubModel([extraction]),
    fetcher: stubFetcher(),
    clock: { now: () => 1_000 },
    budget: { maxFetches: 12, deadlineMs: 60_000 },
    newRunId: () => "run-test",
    ...overrides,
  };
}

async function run(
  input: AnalyzeInput,
  deps: PipelineDeps,
  cancel: AbortSignal = new AbortController().signal,
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  await runAnalysis(input, deps, (event) => events.push(PipelineEventSchema.parse(event)), {
    cancel,
  });
  return events;
}

const types = (events: PipelineEvent[]) => events.map((e) => e.type);

describe("runAnalysis — happy paths", () => {
  // The extraction stub yields no domain, so tiers 1–3 have no candidates:
  // enrichment contributes exactly its stage marker, four tier frames, and
  // the counts-only summary.
  it("text input: extraction -> enrichment (Tier 0 = pasted ref) -> completed, zero fetches", async () => {
    const events = await run(TEXT_INPUT, makeDeps());
    expect(types(events)).toEqual([
      "run.started",
      "stage.started",
      "step.started",
      "step.finished",
      "extraction.completed",
      "stage.started",
      "enrichment.tier.completed",
      "enrichment.tier.completed",
      "enrichment.tier.completed",
      "enrichment.tier.completed",
      "enrichment.completed",
      "run.completed",
    ]);
    expect(events[0]).toMatchObject({
      runId: "run-test",
      provider: { id: "stub" },
      budget: { maxFetches: 12, deadlineMs: 60_000 },
      input: { kind: "text" },
    });
    expect(events[2]).toMatchObject({ stepId: "listing-extract", stage: "extraction" });
    expect(events[3]).toMatchObject({ stepId: "listing-extract", status: "ok" });
    expect(events[5]).toMatchObject({ stage: "enrichment" });
    expect(events[6]).toMatchObject({
      tier: 0,
      status: "found",
      sources: [{ url: "listing:pasted", label: "Pasted listing text" }],
    });
    expect(events[10]).toMatchObject({
      summary: {
        tiers: [
          { tier: 0, status: "found", sourceCount: 1 },
          { tier: 1, status: "not_found", sourceCount: 0 },
          { tier: 2, status: "not_found", sourceCount: 0 },
          { tier: 3, status: "not_found", sourceCount: 0 },
        ],
        fetchesUsed: 0,
      },
    });
    expect(events[11]).toMatchObject({ runId: "run-test", fetchCount: 0 });
  });

  it("url input: fetch step precedes extract; Tier 0 cites the fetched listing ref", async () => {
    const events = await run(URL_INPUT, makeDeps({ fetcher: stubFetcher(page) }));
    expect(types(events).slice(0, 8)).toEqual([
      "run.started",
      "stage.started",
      "step.started",
      "step.finished",
      "step.started",
      "step.finished",
      "extraction.completed",
      "stage.started",
    ]);
    expect(types(events).slice(-2)).toEqual(["enrichment.completed", "run.completed"]);
    expect(events[2]).toMatchObject({ stepId: "listing-fetch", url: page.url });
    expect(events[3]).toMatchObject({
      stepId: "listing-fetch",
      status: "ok",
      source: { url: page.finalUrl },
    });
    expect(events[4]).toMatchObject({ stepId: "listing-extract" });
    expect(events[8]).toMatchObject({
      type: "enrichment.tier.completed",
      tier: 0,
      status: "found",
      sources: [{ url: page.finalUrl }],
    });
    expect(events.at(-1)).toMatchObject({ fetchCount: 1 });
  });

  it("clamps env budget knobs into run.started (ceilings and NaN fallback)", async () => {
    const clamped = await run(TEXT_INPUT, makeDeps({ budget: { maxFetches: 999, deadlineMs: 999_999 } }));
    expect(clamped[0]).toMatchObject({ budget: { maxFetches: 20, deadlineMs: 120_000 } });
    const defaulted = await run(TEXT_INPUT, makeDeps({ budget: { maxFetches: NaN, deadlineMs: NaN } }));
    expect(defaulted[0]).toMatchObject({ budget: { maxFetches: 12, deadlineMs: 60_000 } });
  });

  it("arms the injected deadline timer with the clamped deadline and disposes it", async () => {
    const dispose = vi.fn();
    const scheduleDeadline = vi.fn(() => dispose);
    await run(TEXT_INPUT, makeDeps({ budget: { maxFetches: 12, deadlineMs: 999_999 }, scheduleDeadline }));
    expect(scheduleDeadline).toHaveBeenCalledWith(expect.any(Function), 120_000);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("runAnalysis — fatal errors (§3 guarantee 3: pair, then terminal)", () => {
  it("listing-fetch skip: step.finished(skipped) precedes run.error INPUT_INVALID with the paste hint", async () => {
    const skip = { kind: "skip" as const, url: page.url, reason: "robots_disallowed" as const };
    const events = await run(URL_INPUT, makeDeps({ fetcher: stubFetcher(skip) }));
    expect(types(events)).toEqual([
      "run.started",
      "stage.started",
      "step.started",
      "step.finished",
      "run.error",
    ]);
    expect(events[3]).toMatchObject({ status: "skipped", skip: { reason: "robots_disallowed" } });
    expect(events[4]).toMatchObject({
      code: "INPUT_INVALID",
      hint: expect.stringContaining("Paste the listing text"),
      stage: "extraction",
    });
  });

  it("a throw mid-extract pairs the open step with a cancelled skip BEFORE run.error", async () => {
    const failure = new PipelineError("EXTRACTION_FAILED", "model never produced valid JSON", {
      hint: "try a stronger model",
      stage: "extraction",
    });
    const events = await run(TEXT_INPUT, makeDeps({ getModel: () => stubModel([failure]) }));
    expect(types(events)).toEqual([
      "run.started",
      "stage.started",
      "step.started",
      "step.finished",
      "run.error",
    ]);
    expect(events[3]).toMatchObject({
      stepId: "listing-extract",
      status: "skipped",
      skip: { reason: "cancelled" },
    });
    expect(events[4]).toMatchObject({ code: "EXTRACTION_FAILED", hint: "try a stronger model" });
  });

  it("maps an unknown throw to INTERNAL", async () => {
    const events = await run(TEXT_INPUT, makeDeps({ getModel: () => stubModel([new Error("boom")]) }));
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "run.error", code: "INTERNAL" });
    expect((terminal as { message: string }).message).toContain("boom");
  });

  it("getModel() throwing MODEL_UNCONFIGURED still yields run.started first, then run.error", async () => {
    const events = await run(
      TEXT_INPUT,
      makeDeps({
        providerId: "unconfigured",
        getModel: () => {
          throw new PipelineError("MODEL_UNCONFIGURED", "No model provider is configured.", {
            hint: "Set OPENAI_API_KEY…",
          });
        },
      }),
    );
    expect(types(events)).toEqual(["run.started", "stage.started", "run.error"]);
    expect(events[0]).toMatchObject({ provider: { id: "unconfigured" } });
    expect(events[2]).toMatchObject({ code: "MODEL_UNCONFIGURED" });
  });
});

describe("runAnalysis — cancellation is silent (§3: no pairing frames, no terminal)", () => {
  it("user cancel mid-extract: resolves with NO terminal event", async () => {
    const cancel = new AbortController();
    let enteredExtract!: () => void;
    const extractEntered = new Promise<void>((resolve) => (enteredExtract = resolve));
    const hanging: ModelProvider = {
      id: "hanging",
      extract: (_input, _schema, opts) => {
        enteredExtract();
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (opts?.abortSignal?.aborted) abort();
          else opts?.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
      async *streamSynthesis() {
        throw new Error("not used");
      },
    };
    const events: PipelineEvent[] = [];
    const done = runAnalysis(
      TEXT_INPUT,
      makeDeps({ getModel: () => hanging }),
      (e) => events.push(PipelineEventSchema.parse(e)),
      { cancel: cancel.signal },
    );
    await extractEntered; // the run is now blocked inside the model call
    cancel.abort();
    await done;
    expect(types(events)).toEqual(["run.started", "stage.started", "step.started"]);
  });

  it("user cancel mid-listing-fetch: the cancelled-skip INPUT_INVALID is swallowed", async () => {
    // The CLAUDE.md increment-5 note: a cancel during the listing fetch
    // surfaces as a cancelled skip -> INPUT_INVALID throw; the abort check
    // must win over the error mapping.
    const cancel = new AbortController();
    const fetcher = {
      async fetchClean(url: string) {
        cancel.abort();
        return { kind: "skip" as const, url, reason: "cancelled" as const };
      },
    };
    const events = await run(URL_INPUT, makeDeps({ fetcher }), cancel.signal);
    expect(types(events)).not.toContain("run.error");
    expect(types(events)).not.toContain("run.completed");
  });

  it("already-cancelled signal: only run.started escapes", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const events = await run(TEXT_INPUT, makeDeps(), cancel.signal);
    expect(types(events)).toEqual(["run.started"]);
  });
});
