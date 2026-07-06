import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnalysis, type PipelineDeps } from "@/domain/pipeline/AnalysisPipeline";
import { PipelineEventSchema, type AnalyzeInput, type PipelineEvent } from "@/shared/schema";
import { STALL_HINT, streamWithWatchdog } from "./inactivityWatchdog";
import type { ModelProvider } from "./ModelProvider";

// Increment-7 verification (PLAN.md §7): a stalled synthesis stream IS killed
// by the inactivity watchdog and surfaces as run.error INTERNAL with the
// stall hint — composed through the REAL pipeline and the REAL watchdog with
// fake timers. This lives outside src/domain/** because domain tests may not
// import provider implementations (eslint layering rule).

const INPUT: AnalyzeInput = {
  kind: "text",
  text: "Driftlock is hiring a Backend Engineer to work on data pipelines in Go.",
};

/** Extraction succeeds instantly; every synthesis stream hangs forever,
 *  bounded only by the watchdog — like a wedged provider mid-briefing. */
function stallingProvider(inactivityMs: number): ModelProvider {
  return {
    id: "stalling",
    async extract(_input, schema) {
      return schema.parse({ company: "Driftlock", role: "Backend Engineer", namedTechnologies: [] });
    },
    streamSynthesis: (prompt) =>
      streamWithWatchdog({ inactivityMs, abortSignal: prompt.abortSignal }, () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<string>>(() => {}),
        }),
      })),
  };
}

describe("stalled synthesis stream → run.error INTERNAL (decision 15)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the watchdog bounds a hung stream even with nobody watching", async () => {
    vi.useFakeTimers();
    const events: PipelineEvent[] = [];
    const deps: PipelineDeps = {
      providerId: "stalling",
      getModel: () => stallingProvider(5_000),
      fetcher: {
        fetchClean: async () => {
          throw new Error("this run must not fetch");
        },
      },
      clock: { now: () => 0 },
      budget: { maxFetches: 12, deadlineMs: 60_000 },
      newRunId: () => "run-stall",
    };
    const done = runAnalysis(INPUT, deps, (event) => events.push(PipelineEventSchema.parse(event)), {
      cancel: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(5_100);
    await done;

    // The first sourced section had opened — its badge/citation frame is out —
    // and the stall then terminated the RUN, not just the call.
    expect(events.some((e) => e.type === "synthesis.section.started")).toBe(true);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "run.error", code: "INTERNAL", hint: STALL_HINT });
    expect((terminal as { message: string }).message).toContain("no progress");
  });
});
