import { describe, expect, it } from "vitest";
import { extraction, stubFetcher } from "@/domain/listing/extractorTestKit";
import { NOT_FOUND_TEXT } from "@/domain/synthesis/BriefingSynthesizer";
import { scriptedModel } from "@/domain/synthesis/synthesisTestKit";
import type { ModelProvider, SynthesisPrompt } from "@/providers/model/ModelProvider";
import { PipelineEventSchema, type AnalyzeInput, type PipelineEvent } from "@/shared/schema";
import { runAnalysis, type PipelineDeps } from "./AnalysisPipeline";
import { PipelineError } from "./errors";

// Stage-3 integration through the pipeline (increment 7): ordering guarantees
// 4–5, the decision-15 rule that the wall clock never kills synthesis, silent
// cancel mid-synthesis, and the hooks failure downgrade. The watchdog-stall
// composition test lives in src/providers/model/pipelineStall.test.ts (the
// layering rule keeps the real watchdog out of domain tests).

const TEXT_INPUT: AnalyzeInput = {
  kind: "text",
  text: "Driftlock is hiring a Backend Engineer to work on data pipelines in Go.",
};

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    providerId: "stub",
    getModel: () =>
      scriptedModel({
        extractions: [extraction, { hooks: [] }],
        streams: [["low section one."], ["low section two."]],
      }),
    fetcher: stubFetcher(),
    clock: { now: () => 1_000 },
    budget: { maxFetches: 12, deadlineMs: 60_000 },
    newRunId: () => "run-test",
    ...overrides,
  };
}

async function run(
  deps: PipelineDeps,
  cancel: AbortSignal = new AbortController().signal,
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  await runAnalysis(TEXT_INPUT, deps, (event) => events.push(PipelineEventSchema.parse(event)), {
    cancel,
  });
  return events;
}

const types = (events: PipelineEvent[]) => events.map((e) => e.type);

describe("runAnalysis — Stage 3 integration", () => {
  it("sections stream serially after enrichment; hooks follow the last section (guarantees 4-5)", async () => {
    const hooked = {
      hooks: [
        {
          text: "The listing owns the ingestion pipeline end to end.",
          basis: "Stated directly in the pasted listing.",
          sourceUrls: ["listing:pasted"],
        },
      ],
    };
    const deps = makeDeps({
      getModel: () =>
        scriptedModel({
          extractions: [extraction, hooked],
          streams: [["chunk A. ", "chunk B."], ["only chunk."]],
        }),
    });
    const events = await run(deps);
    const kinds = types(events);

    // Stage marker: synthesis starts strictly after enrichment completed.
    expect(kinds.indexOf("stage.started", kinds.indexOf("enrichment.completed")))
      .toBeGreaterThan(kinds.indexOf("enrichment.completed"));

    // Guarantee 4: deltas only inside their own section window.
    let open: string | null = null;
    for (const event of events) {
      if (event.type === "synthesis.section.started") open = event.sectionId;
      else if (event.type === "synthesis.section.completed") open = null;
      else if (event.type === "synthesis.delta") expect(event.sectionId).toBe(open);
    }

    // Guarantee 5: hooks.completed after the LAST section.completed, with its
    // own step pair in between; run.completed is terminal.
    const lastSection = kinds.lastIndexOf("synthesis.section.completed");
    const hooksStep = kinds.indexOf("step.started", lastSection);
    const hooksDone = kinds.indexOf("synthesis.hooks.completed");
    expect(hooksStep).toBeGreaterThan(lastSection);
    expect(hooksDone).toBeGreaterThan(hooksStep);
    expect(kinds.at(-1)).toBe("run.completed");

    // The grounded hook rode the wire citing the canonical pasted ref.
    const hooks = events.find((e) => e.type === "synthesis.hooks.completed");
    expect(hooks).toMatchObject({
      hooks: [{ confidence: "low", sources: [{ url: "listing:pasted" }] }],
    });

    // None sections carried the canned copy with empty sources — no model call.
    const none = events.filter(
      (e): e is Extract<PipelineEvent, { type: "synthesis.section.completed" }> =>
        e.type === "synthesis.section.completed" && e.section.confidence === "none",
    );
    expect(none).toHaveLength(4);
    for (const event of none) {
      expect(event.section.content).toBe(NOT_FOUND_TEXT);
      expect(event.section.sources).toEqual([]);
    }
  });

  it("a deadline that fires during synthesis never kills the model streams (decision 15)", async () => {
    let now = 1_000;
    let fireDeadline: (() => void) | undefined;
    const inner = scriptedModel({
      extractions: [extraction, { hooks: [] }],
      streams: [["alpha."], ["beta."]],
    });
    const model: ModelProvider = {
      ...inner,
      streamSynthesis(prompt: SynthesisPrompt) {
        // The wall clock sails past the 60s deadline and the route's real
        // timer fires — while a synthesis stream is live.
        now += 120_000;
        fireDeadline?.();
        return inner.streamSynthesis(prompt);
      },
    };
    const events = await run(
      makeDeps({
        clock: { now: () => now },
        getModel: () => model,
        scheduleDeadline: (fire) => {
          fireDeadline = fire;
          return () => {};
        },
      }),
    );

    expect(types(events)).not.toContain("run.error");
    const completedSections = events.filter((e) => e.type === "synthesis.section.completed");
    expect(completedSections).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      elapsedMs: 240_000, // two streams, each jumping the clock past the deadline
    });
  });

  it("cancel mid-synthesis: completed sections stand, then silence — no terminal frames", async () => {
    const cancel = new AbortController();
    const inner = scriptedModel({ extractions: [extraction] });
    let call = 0;
    const model: ModelProvider = {
      ...inner,
      async *streamSynthesis(prompt: SynthesisPrompt) {
        call += 1;
        yield "first chunk. ";
        if (call === 2) {
          cancel.abort(); // the user cancels while section two is streaming
          prompt.abortSignal?.throwIfAborted();
        }
        yield "second chunk.";
      },
    };
    const events = await run(makeDeps({ getModel: () => model }), cancel.signal);
    const kinds = types(events);

    expect(kinds).not.toContain("run.completed");
    expect(kinds).not.toContain("run.error");
    expect(kinds).not.toContain("synthesis.hooks.completed");
    // Section one (and the instant none sections between) completed and stay.
    const completed = events.filter(
      (e): e is Extract<PipelineEvent, { type: "synthesis.section.completed" }> =>
        e.type === "synthesis.section.completed",
    );
    expect(completed.map((e) => e.section.id)).toContain("what-they-do");
    // Section two started but never completed — the abort tore the stream.
    const lastStarted = events.filter((e) => e.type === "synthesis.section.started").at(-1);
    expect(lastStarted).toMatchObject({ sectionId: "seniority-fit" });
    expect(completed.map((e) => e.section.id)).not.toContain("seniority-fit");
  });

  it("a hooks EXTRACTION_FAILED degrades to zero hooks; the run still completes", async () => {
    const failure = new PipelineError("EXTRACTION_FAILED", "no valid hooks JSON after repair");
    const events = await run(
      makeDeps({
        getModel: () =>
          scriptedModel({
            extractions: [extraction, failure],
            streams: [["low section one."], ["low section two."]],
          }),
      }),
    );
    const kinds = types(events);
    expect(kinds).not.toContain("run.error");
    expect(kinds.at(-1)).toBe("run.completed");
    const hooksStepFinish = events.filter(
      (e): e is Extract<PipelineEvent, { type: "step.finished" }> =>
        e.type === "step.finished" && e.stepId === "synthesis-hooks",
    );
    expect(hooksStepFinish).toHaveLength(1);
    expect(hooksStepFinish[0]).toMatchObject({
      status: "skipped",
      skip: { reason: "empty_content" },
    });
    expect(events.find((e) => e.type === "synthesis.hooks.completed")).toMatchObject({
      hooks: [],
    });
  });
});
