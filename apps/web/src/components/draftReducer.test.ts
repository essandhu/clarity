import { describe, expect, it } from "vitest";
import { PipelineEventSchema, type PipelineEvent } from "@/shared/schema";
import { draftReducer, initialDraftState, type DraftState } from "./useDraftRun";

// The draft stream's client contract, tested like runReducer: pure reducer,
// zod-validated frames, zero DOM, zero network.

const frame = (seq: number, event: PipelineEvent) => ({
  seq,
  event: PipelineEventSchema.parse(event),
});

const note = {
  subject: "Backend Engineer at Acme",
  body: "Hello,\nfull canonical note.\n\nBest,",
  groundedHooks: ["Acme migrated to Rust."],
};

function streamed(): DraftState {
  let state = draftReducer(initialDraftState, { type: "submit" });
  state = draftReducer(state, frame(0, { type: "draft.started" }));
  state = draftReducer(state, frame(1, { type: "draft.delta", text: "Hello," }));
  state = draftReducer(state, frame(2, { type: "draft.delta", text: " partial" }));
  return state;
}

describe("draftReducer", () => {
  it("accumulates deltas while streaming", () => {
    const state = streamed();
    expect(state.phase).toBe("streaming");
    expect(state.text).toBe("Hello, partial");
  });

  it("replaces the streamed buffer with the canonical note on draft.completed", () => {
    const state = draftReducer(streamed(), frame(3, { type: "draft.completed", note }));
    expect(state.phase).toBe("done");
    expect(state.note).toEqual(note);
    expect(state.text).toBe(note.body);
  });

  it("drops duplicate and late frames (seq guard + phase guard)", () => {
    const state = streamed();
    expect(draftReducer(state, frame(1, { type: "draft.delta", text: "again" }))).toBe(state);
    const done = draftReducer(state, frame(3, { type: "draft.completed", note }));
    expect(draftReducer(done, frame(4, { type: "draft.delta", text: "late" }))).toBe(done);
  });

  it("ignores heartbeats except for the seq watermark", () => {
    const state = draftReducer(streamed(), frame(3, { type: "heartbeat" }));
    expect(state.phase).toBe("streaming");
    expect(state.text).toBe("Hello, partial");
    expect(state.lastSeq).toBe(3);
  });

  it("maps run.error to the error phase with the hint folded in", () => {
    const state = draftReducer(
      streamed(),
      frame(3, {
        type: "run.error",
        code: "INTERNAL",
        message: "The model stream stalled.",
        hint: "Check Ollama.",
      }),
    );
    expect(state.phase).toBe("error");
    expect(state.error).toBe("The model stream stalled. Check Ollama.");
  });

  it("keeps partial text on user abort and returns to idle for a redraft", () => {
    const state = draftReducer(streamed(), { type: "aborted" });
    expect(state.phase).toBe("idle");
    expect(state.text).toBe("Hello, partial");
  });

  it("treats a dead stream without a terminal frame as a transport error", () => {
    const state = draftReducer(streamed(), { type: "transport_error" });
    expect(state.phase).toBe("error");
    expect(state.error).toContain("connection closed");
  });

  it("resubmit starts clean", () => {
    const done = draftReducer(streamed(), frame(3, { type: "draft.completed", note }));
    const fresh = draftReducer(done, { type: "submit" });
    expect(fresh).toEqual({ ...initialDraftState, phase: "streaming" });
  });
});
