"use client";

import { useCallback, useReducer, useRef } from "react";
import type { AnalyzeInput } from "@/shared/schema";
import { runReducer } from "./runReducer";
import { initialRunState, type RunState } from "./runState";
import { pumpSseRun } from "./sseClient";

// Fetch-stream lifecycle (PLAN.md §6 Transport): the shared pumpSseRun does
// POST -> reader -> parseSse -> zod re-validate -> seq-guarded dispatch. If
// the stream closes without a terminal event and the user did NOT abort, a
// local transport_error keeps the UI out of a stuck 'running'.

export interface AnalysisRun {
  state: RunState;
  start(input: AnalyzeInput): void;
  cancel(): void;
  reset(): void;
}

export function useAnalysisRun(): AnalysisRun {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const start = useCallback((input: AnalyzeInput) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "submit" });
    void pumpSseRun({
      url: "/api/analyze",
      body: input,
      controller,
      isTerminal: (event) => event.type === "run.completed" || event.type === "run.error",
      dispatch,
    }).finally(() => {
      runningRef.current = false;
    });
  }, []);

  const cancel = useCallback(() => {
    // Order matters: abort first so the pump's in-flight read rejects as a
    // user abort, then the local action authoritatively closes open steps.
    controllerRef.current?.abort();
    dispatch({ type: "aborted" });
  }, []);

  const reset = useCallback(() => {
    if (!runningRef.current) dispatch({ type: "reset" });
  }, []);

  return { state, start, cancel, reset };
}
