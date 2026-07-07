import { describe, expect, it } from "vitest";
import { PipelineEventSchema, type PipelineEvent } from "@/shared/schema";
import { runReducer } from "./runReducer";
import { initialRunState, type RunState } from "./runState";

// Increment 9 review finding: the §7 "cached" tag deliverable had no client
// test — deleting the reducer's `cached: event.cached` propagation kept the
// whole suite green. These pin the wire→StepView path StepRow renders from.

const wire = (state: RunState, seq: number, event: PipelineEvent): RunState =>
  runReducer(state, { seq, event: PipelineEventSchema.parse(event) });

const SOURCE = {
  url: "https://acme.dev/about",
  label: "About Acme",
  fetchedAt: "2026-07-06T12:00:00.000Z",
};

describe("runReducer — cached step tag (increment 9)", () => {
  it("a step.finished carrying cached:true lands on the StepView StepRow renders", () => {
    let state = runReducer(initialRunState, { type: "submit" });
    state = wire(state, 0, {
      type: "step.started",
      stepId: "enrich-1-1",
      stage: "enrichment",
      label: "Reading about page…",
      url: SOURCE.url,
      tier: 1,
    });
    state = wire(state, 1, {
      type: "step.finished",
      stepId: "enrich-1-1",
      status: "ok",
      source: SOURCE,
      cached: true,
    });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({
      stepId: "enrich-1-1",
      status: "ok",
      source: SOURCE,
      cached: true,
    });
  });

  it("a fresh fetch's step carries no cached flag — the tag must not render", () => {
    let state = runReducer(initialRunState, { type: "submit" });
    state = wire(state, 0, {
      type: "step.started",
      stepId: "enrich-1-2",
      stage: "enrichment",
      label: "Reading careers page…",
    });
    state = wire(state, 1, {
      type: "step.finished",
      stepId: "enrich-1-2",
      status: "ok",
      source: SOURCE,
    });
    expect(state.steps[0].status).toBe("ok");
    expect(state.steps[0].cached).toBeUndefined();
  });
});
