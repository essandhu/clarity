"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DraftNote, DraftRequest, PipelineEvent } from "@/shared/schema";
import { pumpSseRun } from "./sseClient";

// The /api/draft stream lifecycle — useAnalysisRun's shape scaled down to
// the three draft.* event types (+ run.error) on the same SSE envelope. The
// reducer is pure and exported for unit tests; the same guards apply: frames
// only in 'streaming', seq-deduped, and a stream that closes without a
// terminal frame (draft.completed XOR run.error) becomes a transport error.

export interface DraftState {
  phase: "idle" | "streaming" | "done" | "error";
  lastSeq: number;
  text: string;
  note?: DraftNote;
  error?: string;
}

export const initialDraftState: DraftState = { phase: "idle", lastSeq: -1, text: "" };

export type DraftAction =
  | { type: "submit" }
  | { type: "aborted" }
  | { type: "transport_error"; message?: string }
  | { seq: number; event: PipelineEvent };

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  if ("seq" in action) return applyWireEvent(state, action.seq, action.event);
  switch (action.type) {
    case "submit":
      return { ...initialDraftState, phase: "streaming" };
    case "aborted":
      // Partial text is kept ("showing what was drafted"); the button
      // returns to idle so the user can redraft.
      return state.phase === "streaming" ? { ...state, phase: "idle" } : state;
    case "transport_error":
      return state.phase === "streaming"
        ? {
            ...state,
            phase: "error",
            error: action.message ?? "The connection closed before the draft finished.",
          }
        : state;
    default:
      return action satisfies never;
  }
}

function applyWireEvent(state: DraftState, seq: number, event: PipelineEvent): DraftState {
  if (seq <= state.lastSeq) return state; // duplicate frame — drop
  if (state.phase !== "streaming") return state; // late frames after abort
  const s: DraftState = { ...state, lastSeq: seq };
  switch (event.type) {
    case "draft.started":
      return { ...s, text: "", note: undefined };
    case "draft.delta":
      return { ...s, text: s.text + event.text };
    case "draft.completed":
      // Canonical body replaces the streamed buffer (§3 event table rule).
      return { ...s, phase: "done", note: event.note, text: event.note.body };
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

export interface DraftRun {
  state: DraftState;
  start(request: DraftRequest): void;
  cancel(): void;
}

export function useDraftRun(): DraftRun {
  const [state, dispatch] = useReducer(draftReducer, initialDraftState);
  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  // The panel unmounts on "Analyze another listing", a new run, or a contact
  // switch — a live draft stream must die with it, or the server keeps
  // generating with nothing listening (review finding).
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback((request: DraftRequest) => {
    if (streamingRef.current) return;
    streamingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "submit" });
    void pumpSseRun({
      url: "/api/draft",
      body: request,
      controller,
      isTerminal: (event) => event.type === "draft.completed" || event.type === "run.error",
      dispatch,
    }).finally(() => {
      streamingRef.current = false;
    });
  }, []);

  const cancel = useCallback(() => {
    // Abort first so the pump's in-flight read rejects as a user abort, then
    // the local action closes the streaming phase (the useAnalysisRun rule).
    controllerRef.current?.abort();
    dispatch({ type: "aborted" });
  }, []);

  return { state, start, cancel };
}
