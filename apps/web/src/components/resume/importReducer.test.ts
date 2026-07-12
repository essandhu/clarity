import { describe, expect, it } from "vitest";
import type { ImportedEntries, ImportReport, PipelineEvent } from "@/shared/schema";
import { importReducer, initialImportState, type ImportState } from "./useResumeImportRun";

// The import stream's client reducer: the draftReducer guard order verbatim
// — seq watermark, then phase gate — plus the §3 terminal handling.

const ENTRIES: ImportedEntries = { experience: [], projects: [], education: [], skills: [] };
const REPORT: ImportReport = { droppedStrings: [], truncated: false, notes: [] };

function streaming(): ImportState {
  return importReducer(initialImportState, { type: "submit" });
}

function wire(state: ImportState, seq: number, event: PipelineEvent): ImportState {
  return importReducer(state, { seq, event });
}

describe("importReducer", () => {
  it("submit resets to a clean streaming state", () => {
    expect(streaming()).toEqual({ phase: "streaming", lastSeq: -1 });
  });

  it("applies started then completed, landing done with entries + report", () => {
    let state = streaming();
    state = wire(state, 0, { type: "profile.import.started" });
    state = wire(state, 1, { type: "heartbeat" });
    state = wire(state, 2, { type: "profile.import.completed", entries: ENTRIES, report: REPORT });
    expect(state.phase).toBe("done");
    expect(state.entries).toEqual(ENTRIES);
    expect(state.report).toEqual(REPORT);
  });

  it("drops duplicate and out-of-order frames on the seq watermark", () => {
    let state = streaming();
    state = wire(state, 5, { type: "profile.import.started" });
    const after = wire(state, 5, {
      type: "profile.import.completed",
      entries: ENTRIES,
      report: REPORT,
    });
    expect(after).toEqual(state); // same seq — dropped
  });

  it("phase gate: frames after an abort are inert (the stale-pump rule)", () => {
    let state = streaming();
    state = importReducer(state, { type: "aborted" });
    expect(state.phase).toBe("idle");
    const after = wire(state, 0, {
      type: "profile.import.completed",
      entries: ENTRIES,
      report: REPORT,
    });
    expect(after).toEqual(state);
  });

  it("run.error lands the error phase with the hint appended", () => {
    let state = streaming();
    state = wire(state, 0, { type: "profile.import.started" });
    state = wire(state, 1, {
      type: "run.error",
      code: "EXTRACTION_FAILED",
      message: "no valid JSON.",
      hint: "Retry.",
    });
    expect(state.phase).toBe("error");
    expect(state.error).toBe("no valid JSON. Retry.");
  });

  it("transport_error only bites mid-stream", () => {
    expect(importReducer(initialImportState, { type: "transport_error" }).phase).toBe("idle");
    const state = importReducer(streaming(), { type: "transport_error" });
    expect(state.phase).toBe("error");
  });

  it("foreign union members fall through harmlessly", () => {
    let state = streaming();
    state = wire(state, 0, { type: "draft.started" });
    expect(state.phase).toBe("streaming");
    expect(state.lastSeq).toBe(0);
  });

  it("dismiss returns to a clean idle after done", () => {
    let state = streaming();
    state = wire(state, 0, { type: "profile.import.completed", entries: ENTRIES, report: REPORT });
    state = importReducer(state, { type: "dismiss" });
    expect(state).toEqual(initialImportState);
  });
});
