"use client";

import { useCallback, useReducer, useRef } from "react";
import { PipelineEventSchema, type AnalyzeInput } from "@/shared/schema";
import { createSseParser } from "./parseSse";
import { runReducer } from "./runReducer";
import { initialRunState, type RunAction, type RunState } from "./runState";

// Fetch-stream lifecycle (PLAN.md §6 Transport): POST -> reader -> parseSse ->
// zod re-validate (the client trusts the schema, not the wire) -> seq-guarded
// dispatch. If the stream closes without a terminal event and the user did
// NOT abort, a local transport_error keeps the UI out of a stuck 'running'.

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
    void pumpRun(input, controller, dispatch).finally(() => {
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

async function pumpRun(
  input: AnalyzeInput,
  controller: AbortController,
  dispatch: (action: RunAction) => void,
): Promise<void> {
  let sawTerminal = false;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      dispatch({ type: "transport_error", message: await readErrorMessage(res) });
      return;
    }
    const reader = res.body.getReader();
    const parser = createSseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) {
        const event = parseEvent(frame.data);
        // Garbled or unknown frames are dropped, never fatal: the protocol
        // may grow, and one bad frame must not kill a live run.
        if (!event) continue;
        const seq = Number(frame.id);
        if (!Number.isInteger(seq)) continue; // our server always stamps id
        if (event.type === "run.completed" || event.type === "run.error") sawTerminal = true;
        dispatch({ seq, event });
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      dispatch({
        type: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (!controller.signal.aborted && !sawTerminal) dispatch({ type: "transport_error" });
}

function parseEvent(data: string): ReturnType<typeof PipelineEventSchema.parse> | undefined {
  try {
    const parsed = PipelineEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Non-JSON error body — fall through to the status line.
  }
  return `The server rejected the request (HTTP ${res.status}).`;
}
