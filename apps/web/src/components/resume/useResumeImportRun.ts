"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ImportedEntries, ImportReport, PipelineEvent } from "@/shared/schema";
import { pumpSseRun } from "../sseClient";

// The pasted-resume import stream lifecycle — draftReducer's shape on the
// same SSE envelope: frames only in 'streaming', seq-deduped, and a stream
// that closes without a terminal frame (profile.import.completed XOR
// run.error) becomes a transport error. The reducer is pure and exported for
// unit tests and the try-import.ts driver.

export interface ImportState {
  phase: "idle" | "streaming" | "done" | "error";
  lastSeq: number;
  entries?: ImportedEntries;
  report?: ImportReport;
  error?: string;
}

export const initialImportState: ImportState = { phase: "idle", lastSeq: -1 };

export type ImportAction =
  | { type: "submit" }
  | { type: "aborted" }
  | { type: "dismiss" }
  | { type: "transport_error"; message?: string }
  | { seq: number; event: PipelineEvent };

export function importReducer(state: ImportState, action: ImportAction): ImportState {
  if ("seq" in action) return applyWireEvent(state, action.seq, action.event);
  switch (action.type) {
    case "submit":
      return { ...initialImportState, phase: "streaming" };
    case "aborted":
      return state.phase === "streaming" ? { ...state, phase: "idle" } : state;
    case "dismiss":
      // The user merged or discarded the result — back to a clean idle.
      return initialImportState;
    case "transport_error":
      return state.phase === "streaming"
        ? {
            ...state,
            phase: "error",
            error: action.message ?? "The connection closed before the import finished.",
          }
        : state;
    default:
      return action satisfies never;
  }
}

function applyWireEvent(state: ImportState, seq: number, event: PipelineEvent): ImportState {
  if (seq <= state.lastSeq) return state; // duplicate frame — drop
  if (state.phase !== "streaming") return state; // late frames after abort
  const s: ImportState = { ...state, lastSeq: seq };
  switch (event.type) {
    case "profile.import.started":
      return { ...s, entries: undefined, report: undefined };
    case "profile.import.completed":
      return { ...s, phase: "done", entries: event.entries, report: event.report };
    case "run.error":
      return {
        ...s,
        phase: "error",
        error: event.hint ? `${event.message} ${event.hint}` : event.message,
      };
    default:
      return s; // heartbeats; nothing else rides this connection
  }
}

export interface ResumeImportRun {
  state: ImportState;
  start(text: string): void;
  cancel(): void;
  dismiss(): void;
}

export function useResumeImportRun(): ResumeImportRun {
  const [state, dispatch] = useReducer(importReducer, initialImportState);
  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  // A live import stream holds a multi-minute CPU model call — it must die
  // with the panel, or the server keeps generating with nothing listening
  // (the useDraftRun unmount rule).
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback((text: string) => {
    if (streamingRef.current) return;
    streamingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "submit" });
    void pumpSseRun({
      url: "/api/profile/import/resume",
      body: { text },
      controller,
      isTerminal: (event) =>
        event.type === "profile.import.completed" || event.type === "run.error",
      dispatch,
    }).finally(() => {
      streamingRef.current = false;
    });
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    dispatch({ type: "aborted" });
  }, []);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  return { state, start, cancel, dismiss };
}
