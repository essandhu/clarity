import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PipelineEventSchema } from "@/shared/schema";
import { runReducer } from "./runReducer";
import { initialRunState, type RunState, type WireAction } from "./runState";

// The reducer is tested by replaying recorded .jsonl event fixtures (PLAN.md
// §6) — full UI-contract coverage with zero DOM and zero network. Every
// fixture line is re-validated against the wire schema, so a drifting fixture
// fails loudly instead of silently testing a protocol that no longer exists.

const fixturesDir = fileURLToPath(new URL("../../fixtures/event-streams/", import.meta.url));

function loadFixture(name: string): WireAction[] {
  return readFileSync(`${fixturesDir}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const raw = JSON.parse(line) as { seq: number; event: unknown };
      return { seq: raw.seq, event: PipelineEventSchema.parse(raw.event) };
    });
}

function replay(name: string): RunState {
  const submitted = runReducer(initialRunState, { type: "submit" });
  return loadFixture(name).reduce(runReducer, submitted);
}

describe("runReducer — fixture replays", () => {
  it("text-run-completed: done, profile rendered, all steps closed ok", () => {
    const state = replay("text-run-completed.jsonl");
    expect(state.phase).toBe("done");
    expect(state.profile?.company).toBe("Lumen Robotics");
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({
      stepId: "listing-extract",
      stage: "extraction",
      status: "ok",
    });
    expect(state.lastSeq).toBe(6);
    expect(state.fatal).toBeUndefined();
  });

  it("url-run-input-invalid: error phase with the paste-steering hint, honest skip row", () => {
    const state = replay("url-run-input-invalid.jsonl");
    expect(state.phase).toBe("error");
    expect(state.fatal).toMatchObject({ code: "INPUT_INVALID" });
    expect(state.fatal?.hint).toContain("Paste the listing text");
    expect(state.steps[0]).toMatchObject({
      status: "skipped",
      skip: { reason: "robots_disallowed" },
    });
  });

  it("text-run-budget (recorded live, CLARITY_MAX_FETCHES=2): budget notice + skipped tiers", () => {
    const state = replay("text-run-budget.jsonl");
    expect(state.phase).toBe("done");
    expect(state.profile?.company).toBe("Vercel");
    expect(state.tiers[0]?.status).toBe("found");
    expect(state.tiers[1]?.status).toBe("found");
    expect(state.tiers[2]?.status).toBe("skipped_budget");
    expect(state.tiers[3]?.status).toBe("skipped_budget");
    expect(state.budgetNotice).toEqual({ kind: "fetches", skippedTiers: [2, 3] });
    expect(state.fetchesUsed).toBe(2);
    expect(state.steps.filter((s) => s.skip?.reason === "budget_exhausted")).toHaveLength(7);
    expect(state.steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("abort-mid-extraction + local aborted action closes every open step", () => {
    const mid = replay("abort-mid-extraction.jsonl");
    expect(mid.phase).toBe("running");
    expect(mid.steps[0].status).toBe("running");
    const state = runReducer(mid, { type: "aborted" });
    expect(state.phase).toBe("cancelled");
    expect(state.steps.every((s) => s.status !== "running")).toBe(true);
    expect(state.steps[0].skip).toMatchObject({ reason: "cancelled" });
    // partials already rendered are kept
    expect(state.runId).toBe("run-fixture-abort");
  });
});

describe("runReducer — ordering and lifecycle guards", () => {
  it("drops duplicate and out-of-order frames (seq <= lastSeq)", () => {
    const state = replay("text-run-completed.jsonl");
    const stale: WireAction = {
      seq: 5,
      event: {
        type: "run.error",
        code: "INTERNAL",
        message: "replayed frame must not apply",
      },
    };
    expect(runReducer(state, stale)).toBe(state);
  });

  it("drops wire frames when no run is in flight (idle / after abort)", () => {
    const [first] = loadFixture("text-run-completed.jsonl");
    expect(runReducer(initialRunState, first)).toBe(initialRunState);
    const cancelled = runReducer(replay("abort-mid-extraction.jsonl"), { type: "aborted" });
    const late: WireAction = { seq: 99, event: { type: "heartbeat" } };
    expect(runReducer(cancelled, late)).toBe(cancelled);
  });

  it("transport_error mid-run: error phase, INTERNAL fatal, steps closed; ignored once finished", () => {
    const mid = replay("abort-mid-extraction.jsonl");
    const dead = runReducer(mid, { type: "transport_error" });
    expect(dead.phase).toBe("error");
    expect(dead.fatal).toMatchObject({ code: "INTERNAL" });
    expect(dead.steps.every((s) => s.status !== "running")).toBe(true);

    const done = replay("text-run-completed.jsonl");
    expect(runReducer(done, { type: "transport_error" })).toBe(done);
    expect(runReducer(done, { type: "aborted" })).toBe(done);
  });

  it("transport_error carries a server-supplied message when present", () => {
    const mid = replay("abort-mid-extraction.jsonl");
    const dead = runReducer(mid, { type: "transport_error", message: "HTTP 400" });
    expect(dead.fatal?.message).toBe("HTTP 400");
  });

  it("submit resets prior results; reset returns to the initial state", () => {
    const done = replay("text-run-completed.jsonl");
    const resubmitted = runReducer(done, { type: "submit" });
    expect(resubmitted.phase).toBe("running");
    expect(resubmitted.profile).toBeUndefined();
    expect(resubmitted.steps).toEqual([]);
    expect(runReducer(done, { type: "reset" })).toEqual(initialRunState);
  });

  it("heartbeat advances lastSeq but changes nothing else", () => {
    const mid = replay("abort-mid-extraction.jsonl");
    const after = runReducer(mid, { seq: 50, event: { type: "heartbeat" } });
    expect(after.lastSeq).toBe(50);
    expect(after.steps).toEqual(mid.steps);
    expect(after.phase).toBe("running");
  });
});

describe("runReducer — enrichment frames (increment 6)", () => {
  const ref = {
    url: "https://acme.dev/",
    label: "Acme Robotics",
    fetchedAt: "2026-07-05T12:00:01.000Z",
  };

  it("tier chips land progressively; the fetch tally arrives with the summary, then run.completed", () => {
    let state = runReducer(initialRunState, { type: "submit" });
    state = runReducer(state, {
      seq: 0,
      event: {
        type: "run.started",
        runId: "run-enrich",
        provider: { id: "stub" },
        budget: { maxFetches: 12, deadlineMs: 60_000 },
        input: { kind: "text" },
      },
    });
    state = runReducer(state, {
      seq: 1,
      event: { type: "enrichment.tier.completed", tier: 0, status: "found", sources: [ref] },
    });
    expect(state.tiers[0]).toEqual({ status: "found", sources: [ref] });
    expect(state.fetchesUsed).toBeUndefined(); // no tally until the summary

    state = runReducer(state, {
      seq: 2,
      event: {
        type: "budget.exhausted",
        kind: "fetches",
        fetchesUsed: 7,
        elapsedMs: 12_000,
        skippedTiers: [2, 3],
      },
    });
    expect(state.budgetNotice).toEqual({ kind: "fetches", skippedTiers: [2, 3] });

    state = runReducer(state, {
      seq: 3,
      event: {
        type: "enrichment.completed",
        summary: {
          tiers: [
            { tier: 0, status: "found", sourceCount: 1 },
            { tier: 1, status: "found", sourceCount: 2 },
            { tier: 2, status: "skipped_budget", sourceCount: 0 },
            { tier: 3, status: "skipped_budget", sourceCount: 0 },
          ],
          fetchesUsed: 7,
        },
      },
    });
    expect(state.fetchesUsed).toBe(7);
    expect(state.phase).toBe("running");

    state = runReducer(state, {
      seq: 4,
      event: { type: "run.completed", runId: "run-enrich", elapsedMs: 40_000, fetchCount: 7 },
    });
    expect(state.phase).toBe("done");
    expect(state.fetchesUsed).toBe(7);
  });
});
