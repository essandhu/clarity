import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PipelineEventSchema,
  type ListingProfile,
  type PipelineEvent,
  type TailorCoverage,
  type TailoredResume,
} from "@/shared/schema";
import {
  initialTailorState,
  tailorReducer,
  type TailorAction,
  type TailorState,
} from "./useTailorRun";

// Pure reducer contract (§6): seq watermark → phase gate, aborted keeps
// completed rows and returns to idle, terminal arms close open rows, foreign
// union members are inert — hand-built sequences plus the LIVE-recorded
// tailor-run.jsonl replay (the runReducer pattern; recorded 2026-07-13 from
// the §7.13 sparse-startup text run on keyless qwen3:4b).

const roleProfile: ListingProfile = {
  company: "Tessellate",
  role: "Platform Engineer",
  namedTechnologies: [],
  rawText: "Tessellate is hiring a Platform Engineer.",
};

const resume: TailoredResume = {
  roleLabel: "Platform Engineer at Tessellate",
  identity: { name: "Maya Chen", links: [] },
  entries: [
    {
      entryId: "exp-1",
      kind: "experience",
      heading: "Driftlock",
      subheading: "Senior Software Engineer",
      bullets: [{ bulletId: "b-1", text: "Rebuilt the pipeline", disposition: "verbatim" }],
    },
  ],
  education: [],
  skills: [],
};

const coverage: TailorCoverage = {
  mode: "tailored",
  entriesTotal: 3,
  entriesOffered: 3,
  entriesSelected: 1,
  bulletsSelected: 1,
  bulletsRephrased: 0,
  bulletsReverted: 0,
  dropped: [],
  keywords: { matched: [], missing: ["Kubernetes"] },
};

const happyFrames: [number, PipelineEvent][] = [
  [0, { type: "tailor.started" }],
  [1, { type: "step.started", stepId: "tailor-role-extract", stage: "tailor", label: "Extracting role profile…" }],
  [2, { type: "step.finished", stepId: "tailor-role-extract", status: "ok" }],
  [3, { type: "tailor.role.completed", profile: roleProfile }],
  [4, { type: "step.started", stepId: "tailor-select", stage: "tailor", label: "Selecting from your master profile…" }],
  [5, { type: "heartbeat" }],
  [6, { type: "step.finished", stepId: "tailor-select", status: "ok" }],
  [7, { type: "tailor.completed", resume, coverage }],
];

function play(state: TailorState, actions: TailorAction[]): TailorState {
  return actions.reduce(tailorReducer, state);
}

function submitAnd(frames: [number, PipelineEvent][]): TailorState {
  return play(initialTailorState, [
    { type: "submit" },
    ...frames.map(([seq, event]) => ({ seq, event })),
  ]);
}

describe("tailorReducer", () => {
  it("happy path: done with resume, coverage, role profile, all steps closed", () => {
    const state = submitAnd(happyFrames);
    expect(state.phase).toBe("done");
    expect(state.tailorRunId).toBe(1);
    expect(state.roleProfile?.company).toBe("Tessellate");
    expect(state.resume).toEqual(resume);
    expect(state.coverage).toEqual(coverage);
    expect(state.steps.map((s) => s.status)).toEqual(["ok", "ok"]);
    expect(state.lastSeq).toBe(7);
  });

  it("drops duplicate seqs", () => {
    const state = submitAnd([happyFrames[0], happyFrames[1], happyFrames[1]]);
    expect(state.steps).toHaveLength(1);
  });

  it("aborted keeps completed rows, closes open ones, returns to idle; late frames drop", () => {
    const mid = submitAnd(happyFrames.slice(0, 5));
    const aborted = tailorReducer(mid, { type: "aborted" });
    expect(aborted.phase).toBe("idle");
    expect(aborted.steps[0].status).toBe("ok");
    expect(aborted.steps[1]).toMatchObject({ status: "skipped", skip: { reason: "cancelled" } });
    const late = tailorReducer(aborted, { seq: 6, event: happyFrames[6][1] });
    expect(late).toEqual(aborted);
  });

  it("transport_error mid-run: error phase, open steps closed", () => {
    const state = play(submitAnd(happyFrames.slice(0, 5)), [{ type: "transport_error" }]);
    expect(state.phase).toBe("error");
    expect(state.error?.message).toContain("connection closed");
    expect(state.steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("run.error: error phase with code + hint, open steps closed", () => {
    const state = submitAnd([
      ...happyFrames.slice(0, 5),
      [6, { type: "run.error", code: "INTERNAL", message: "stalled", hint: "retry" }],
    ]);
    expect(state.phase).toBe("error");
    expect(state.error).toEqual({ code: "INTERNAL", message: "stalled", hint: "retry" });
    expect(state.steps[1].status).toBe("skipped");
  });

  it("foreign union members are inert beyond the watermark", () => {
    const base = submitAnd(happyFrames.slice(0, 2));
    const state = tailorReducer(base, {
      seq: 9,
      event: { type: "draft.delta", text: "stray" },
    });
    expect(state).toEqual({ ...base, lastSeq: 9 });
  });

  it("a re-run mints a fresh tailorRunId (toggle-state identity)", () => {
    const done = submitAnd(happyFrames);
    const rerun = play(done, [
      { type: "submit" },
      { seq: 0, event: { type: "tailor.started" } },
    ]);
    expect(rerun.tailorRunId).toBe(2);
    expect(rerun.resume).toBeUndefined();
  });

  it("reset returns to initial, preserving the run counter", () => {
    const state = tailorReducer(submitAnd(happyFrames), { type: "reset" });
    expect(state).toEqual({ ...initialTailorState, tailorRunId: 1 });
  });
});

describe("tailorReducer — live-recorded fixture replays", () => {
  const fixturePath = fileURLToPath(
    new URL("../../../fixtures/event-streams/tailor-run.jsonl", import.meta.url),
  );
  const recorded: TailorAction[] = readFileSync(fixturePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const raw = JSON.parse(line) as { seq: number; event: unknown };
      return { seq: raw.seq, event: PipelineEventSchema.parse(raw.event) };
    });

  it("full replay: done, role profile, resume + coverage, all steps ok", () => {
    const state = play(initialTailorState, [{ type: "submit" }, ...recorded]);
    expect(state.phase).toBe("done");
    expect(state.tailorRunId).toBe(1);
    expect(state.roleProfile?.company).toBe("Driftlock");
    expect(state.resume?.roleLabel).toBe("Backend Engineer at Driftlock");
    expect(state.resume?.entries.map((e) => e.entryId)).toEqual(["exp-driftlock", "exp-acme"]);
    expect(state.coverage).toMatchObject({ mode: "tailored", entriesSelected: 2 });
    expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["tailor-role-extract", "ok"],
      ["tailor-select", "ok"],
    ]);
    expect(state.steps.every((s) => s.stage === "tailor")).toBe(true);
  });

  it("abort-prefix variant: mid-selection abort keeps the ok row, closes the open one", () => {
    const midSelection = recorded.filter((a) => "seq" in a && a.seq <= 7);
    const state = play(initialTailorState, [
      { type: "submit" },
      ...midSelection,
      { type: "aborted" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["tailor-role-extract", "ok"],
      ["tailor-select", "skipped"],
    ]);
    expect(state.resume).toBeUndefined();
  });

  it("run.error variant: a stall after the prefix lands error with the hint, rows closed", () => {
    const midSelection = recorded.filter((a) => "seq" in a && a.seq <= 7);
    const state = play(initialTailorState, [
      { type: "submit" },
      ...midSelection,
      {
        seq: 8,
        event: {
          type: "run.error",
          code: "INTERNAL",
          message: "The model stopped responding.",
          hint: "Check that Ollama is still running.",
        },
      },
    ]);
    expect(state.phase).toBe("error");
    expect(state.error?.code).toBe("INTERNAL");
    expect(state.steps[1]).toMatchObject({ stepId: "tailor-select", status: "skipped" });
  });
});
