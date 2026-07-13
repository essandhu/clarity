"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  ListingProfile,
  PipelineEvent,
  TailorCoverage,
  TailoredResume,
  TailorRoleInput,
} from "@/shared/schema";
import type { StepView } from "../runState";
import { pumpSseRun } from "../sseClient";

// The /api/tailor stream lifecycle (PLAN-RESUME.md §6) — draftReducer's
// guards on the same SSE envelope: seq watermark THEN phase gate, canonical
// payloads on the terminal frame, `aborted` keeps completed rows and returns
// to idle, terminal arms close open step rows (steps have no server-side
// pairing on a dead connection — §3 guarantee 3), and foreign union members
// fall through default. The reducer is pure and exported for the replay
// tests and the try-tailor.ts driver.

export interface TailorState {
  phase: "idle" | "running" | "done" | "error";
  lastSeq: number;
  /** Per-run identity for toggle state (§6): minted at each tailor.started —
   *  a monotonic counter, because a roleLabel would collide across re-runs
   *  of the same role and leak stale toggles. */
  tailorRunId: number;
  steps: StepView[];
  roleProfile?: ListingProfile;
  resume?: TailoredResume;
  coverage?: TailorCoverage;
  error?: { code: string; message: string; hint?: string };
}

export const initialTailorState: TailorState = {
  phase: "idle",
  lastSeq: -1,
  tailorRunId: 0,
  steps: [],
};

export type TailorAction =
  | { type: "submit" }
  | { type: "aborted" }
  | { type: "reset" }
  | { type: "transport_error"; message?: string }
  | { seq: number; event: PipelineEvent };

export function tailorReducer(state: TailorState, action: TailorAction): TailorState {
  if ("seq" in action) return applyWireEvent(state, action.seq, action.event);
  switch (action.type) {
    case "submit":
      return { ...initialTailorState, tailorRunId: state.tailorRunId, phase: "running" };
    case "reset":
      return { ...initialTailorState, tailorRunId: state.tailorRunId };
    case "aborted":
      // Completed rows are kept; the button returns to idle for a re-run.
      return state.phase === "running"
        ? { ...state, phase: "idle", steps: closeOpenSteps(state.steps) }
        : state;
    case "transport_error":
      return state.phase === "running"
        ? {
            ...state,
            phase: "error",
            steps: closeOpenSteps(state.steps),
            error: {
              code: "INTERNAL",
              message: action.message ?? "The connection closed before the tailor run finished.",
            },
          }
        : state;
    default:
      return action satisfies never;
  }
}

function applyWireEvent(state: TailorState, seq: number, event: PipelineEvent): TailorState {
  if (seq <= state.lastSeq) return state; // duplicate frame — drop
  if (state.phase !== "running") return state; // late frames after abort/reset
  const s: TailorState = { ...state, lastSeq: seq };
  switch (event.type) {
    case "tailor.started":
      return {
        ...s,
        tailorRunId: s.tailorRunId + 1,
        steps: [],
        roleProfile: undefined,
        resume: undefined,
        coverage: undefined,
        error: undefined,
      };
    case "step.started":
      return {
        ...s,
        steps: [
          ...s.steps,
          {
            stepId: event.stepId,
            stage: event.stage,
            label: event.label,
            url: event.url,
            tier: event.tier,
            status: "running",
          },
        ],
      };
    case "step.finished":
      return {
        ...s,
        steps: s.steps.map((step) =>
          step.stepId === event.stepId
            ? { ...step, status: event.status, skip: event.skip, source: event.source }
            : step,
        ),
      };
    case "tailor.role.completed":
      return { ...s, roleProfile: event.profile };
    case "tailor.completed":
      return {
        ...s,
        phase: "done",
        resume: event.resume,
        coverage: event.coverage,
        steps: closeOpenSteps(s.steps), // belt-and-braces; the server pairs first
      };
    case "run.error":
      return {
        ...s,
        phase: "error",
        steps: closeOpenSteps(s.steps),
        error: { code: event.code, message: event.message, hint: event.hint },
      };
    default:
      return s; // heartbeats + foreign union members never rendered here
  }
}

function closeOpenSteps(steps: StepView[]): StepView[] {
  return steps.map((step) =>
    step.status === "running"
      ? {
          ...step,
          status: "skipped" as const,
          skip: { kind: "skip" as const, reason: "cancelled" as const },
        }
      : step,
  );
}

export interface TailorRun {
  state: TailorState;
  start(role: TailorRoleInput): void;
  cancel(): void;
  reset(): void;
}

export function useTailorRun(): TailorRun {
  const [state, dispatch] = useReducer(tailorReducer, initialTailorState);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  // A live tailor stream holds a multi-minute CPU model call — it must die
  // with the view, or the server keeps generating with nothing listening
  // (the useDraftRun unmount rule).
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback((role: TailorRoleInput) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "submit" });
    void pumpSseRun({
      url: "/api/tailor",
      body: { role },
      controller,
      isTerminal: (event) => event.type === "tailor.completed" || event.type === "run.error",
      dispatch,
    }).finally(() => {
      runningRef.current = false;
    });
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    dispatch({ type: "aborted" });
  }, []);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, start, cancel, reset };
}
