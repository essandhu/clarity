import { describe, expect, it } from "vitest";
import { extraction, stubModel } from "@/domain/listing/extractorTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import {
  PipelineEventSchema,
  type AnalyzeInput,
  type CleanPage,
  type PipelineEvent,
} from "@/shared/schema";
import { runAnalysis, type PipelineDeps } from "./AnalysisPipeline";

// Stage-2 integration through the pipeline (increment 6): ordering guarantee
// 2 (stages strictly sequential), silent cancel teardown, and the decision-15
// rule that the deadline degrades enrichment but never terminates a run.
// Split from AnalysisPipeline.test.ts under the ~200-line ceiling.

const TEXT_INPUT: AnalyzeInput = {
  kind: "text",
  text: "Acme Robotics is hiring a Backend Engineer to own the ingestion pipeline.",
};

const page = (url: string, extra: Partial<CleanPage> = {}): CleanPage => ({
  kind: "page",
  url,
  finalUrl: url,
  title: "Acme Robotics",
  text: "Acme Robotics builds warehouse robots for small operators. ".repeat(5),
  fetchedAt: "2026-07-05T12:00:01.000Z",
  ...extra,
});

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    providerId: "stub",
    getModel: () => stubModel([{ ...extraction, company: "Acme Robotics", domain: "acme.dev" }]),
    fetcher: new FakePageFetcher(),
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

describe("runAnalysis — Stage 2 integration", () => {
  it("budgeted tier fetches run strictly between the stage markers, statuses honest", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": page("https://acme.dev/", {
        links: [{ url: "https://acme.dev/blog", text: "Blog" }],
      }),
      "https://acme.dev/about": page("https://acme.dev/about"),
      "https://acme.dev/blog": page("https://acme.dev/blog", { title: "Acme Field Notes" }),
    });
    const events = await run(makeDeps({ fetcher }));

    const kinds = types(events);
    const enrichmentStart = kinds.indexOf("stage.started", kinds.indexOf("extraction.completed"));
    expect(enrichmentStart).toBeGreaterThan(kinds.indexOf("extraction.completed"));
    const enrichmentEnd = kinds.indexOf("enrichment.completed");
    expect(enrichmentEnd).toBeGreaterThan(enrichmentStart);
    expect(kinds.at(-1)).toBe("run.completed");

    // Guarantee 2: every enrichment step frame sits inside the stage window.
    events.forEach((event, i) => {
      if (event.type === "step.started" && event.stage === "enrichment") {
        expect(i).toBeGreaterThan(enrichmentStart);
        expect(i).toBeLessThan(enrichmentEnd);
      }
    });

    const tierStatuses = events
      .filter((e): e is Extract<PipelineEvent, { type: "enrichment.tier.completed" }> =>
        e.type === "enrichment.tier.completed",
      )
      .map((e) => [e.tier, e.status]);
    expect(tierStatuses).toEqual([
      [0, "found"],
      [1, "found"],
      [2, "found"],
      [3, "not_found"],
    ]);

    const completed = events.at(-1) as Extract<PipelineEvent, { type: "run.completed" }>;
    expect(completed.fetchCount).toBe(fetcher.calls.length); // 5 tier-1 + 1 discovered blog
    expect(completed.fetchCount).toBe(6);
  });

  it("user cancel mid-enrichment: steps close as cancelled, then silence — no terminal frames", async () => {
    const cancel = new AbortController();
    const fetcher = new FakePageFetcher({ "https://acme.dev/": page("https://acme.dev/") });
    const original = fetcher.fetchClean.bind(fetcher);
    fetcher.fetchClean = async (url, token) => {
      cancel.abort();
      return original(url, token);
    };
    const events = await run(makeDeps({ fetcher }), cancel.signal);

    expect(types(events)).not.toContain("run.completed");
    expect(types(events)).not.toContain("run.error");
    expect(types(events)).not.toContain("enrichment.completed");
    const tierFrames = events.filter((e) => e.type === "enrichment.tier.completed");
    expect(tierFrames).toHaveLength(1); // Tier 0 landed before the abort
    const started = events.filter(
      (e): e is Extract<PipelineEvent, { type: "step.started" }> =>
        e.type === "step.started" && e.stage === "enrichment",
    );
    const finished = events.filter(
      (e): e is Extract<PipelineEvent, { type: "step.finished" }> => e.type === "step.finished",
    );
    expect(started.length).toBeGreaterThan(0);
    for (const step of started) {
      const pair = finished.find((f) => f.stepId === step.stepId);
      expect(pair?.skip?.reason).toBe("cancelled");
    }
  });

  it("deadline fired mid-enrichment degrades tiers but still completes the run (decision 15)", async () => {
    let fireDeadline: (() => void) | undefined;
    const fetcher = new FakePageFetcher({ "https://acme.dev/": page("https://acme.dev/") });
    const original = fetcher.fetchClean.bind(fetcher);
    fetcher.fetchClean = async (url, token) => {
      fireDeadline?.(); // the run deadline passes while tier 1 is in flight
      return original(url, token);
    };
    const events = await run(
      makeDeps({
        fetcher,
        scheduleDeadline: (fire) => {
          fireDeadline = fire;
          return () => {};
        },
      }),
    );

    expect(types(events).at(-1)).toBe("run.completed"); // degraded, never dead
    const tierStatuses = events
      .filter((e): e is Extract<PipelineEvent, { type: "enrichment.tier.completed" }> =>
        e.type === "enrichment.tier.completed",
      )
      .map((e) => [e.tier, e.status]);
    // Tier 1's in-flight fetches died as cancelled skips (not_found);
    // tier 2's slug guesses could not even acquire tokens (skipped_budget).
    expect(tierStatuses).toEqual([
      [0, "found"],
      [1, "not_found"],
      [2, "skipped_budget"],
      [3, "not_found"],
    ]);
    const notices = events.filter((e) => e.type === "budget.exhausted");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "wall_clock", skippedTiers: [2] });
  });
});
