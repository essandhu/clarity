import type { PipelineEvent } from "@/shared/schema";
import {
  initialRunState,
  type RunAction,
  type RunState,
  type StepView,
} from "./runState";

// Pure client reducer (PLAN.md §6): (RunState, PipelineEvent | LocalAction) ->
// RunState. Exhaustive over the event union — a new event type is a compile
// error here, not a rendering bug. Tested by replaying recorded .jsonl
// fixtures; zero DOM, zero network.

export function runReducer(state: RunState, action: RunAction): RunState {
  if ("seq" in action) return applyWireEvent(state, action.seq, action.event);
  switch (action.type) {
    case "submit":
      return { ...initialRunState, phase: "running" };
    case "reset":
      return initialRunState;
    case "aborted":
      // Authoritative local close-out for user cancellation (§3 guarantee 3):
      // everything already rendered is kept.
      return state.phase === "running"
        ? { ...state, phase: "cancelled", steps: closeOpenSteps(state.steps) }
        : state;
    case "transport_error":
      // Stream died without a terminal event and without a user abort.
      return state.phase === "running"
        ? {
            ...state,
            phase: "error",
            steps: closeOpenSteps(state.steps),
            fatal: {
              code: "INTERNAL",
              message: action.message ?? "The connection closed before the run finished.",
            },
          }
        : state;
    default:
      return action satisfies never;
  }
}

function applyWireEvent(state: RunState, seq: number, event: PipelineEvent): RunState {
  if (seq <= state.lastSeq) return state; // duplicate frame — drop
  if (state.phase !== "running") return state; // late frames after abort/reset
  const s: RunState = { ...state, lastSeq: seq };
  switch (event.type) {
    case "run.started":
      return { ...s, runId: event.runId, provider: event.provider, budget: event.budget };
    case "heartbeat":
      return s; // liveness only
    case "stage.started":
      return s; // the timeline groups by each step's own stage
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
            ? {
                ...step,
                status: event.status,
                skip: event.skip,
                source: event.source,
                cached: event.cached,
              }
            : step,
        ),
      };
    case "extraction.completed":
      return { ...s, profile: event.profile };
    case "enrichment.tier.completed":
      return {
        ...s,
        tiers: { ...s.tiers, [event.tier]: { status: event.status, sources: event.sources } },
      };
    case "budget.exhausted":
      return { ...s, budgetNotice: { kind: event.kind, skippedTiers: event.skippedTiers } };
    case "enrichment.completed":
      // Per-tier data already arrived via enrichment.tier.completed; the
      // summary's only news is the fetch tally.
      return { ...s, fetchesUsed: event.summary.fetchesUsed };
    case "synthesis.section.started":
      return {
        ...s,
        sections: {
          ...s.sections,
          [event.sectionId]: {
            title: event.title,
            confidence: event.confidence,
            sources: event.sources,
            text: "",
            done: false,
          },
        },
        sectionOrder: s.sectionOrder.includes(event.sectionId)
          ? s.sectionOrder
          : [...s.sectionOrder, event.sectionId],
      };
    case "synthesis.delta": {
      const section = s.sections[event.sectionId];
      if (!section) return s;
      return {
        ...s,
        sections: {
          ...s.sections,
          [event.sectionId]: { ...section, text: section.text + event.text },
        },
      };
    }
    case "synthesis.section.completed":
      return {
        ...s,
        sections: {
          ...s.sections,
          // Canonical content replaces the streamed buffer (§3 event table).
          [event.section.id]: {
            title: event.section.title,
            confidence: event.section.confidence,
            sources: event.section.sources,
            text: event.section.content,
            done: true,
          },
        },
        sectionOrder: s.sectionOrder.includes(event.section.id)
          ? s.sectionOrder
          : [...s.sectionOrder, event.section.id],
      };
    case "synthesis.hooks.completed":
      return { ...s, hooks: event.hooks };
    case "run.completed":
      return { ...s, phase: "done", fetchesUsed: event.fetchCount };
    case "run.error":
      // The server pairs outstanding steps before the terminal frame
      // (§3 guarantee 3); closing again here is a harmless belt-and-braces.
      return {
        ...s,
        phase: "error",
        steps: closeOpenSteps(s.steps),
        fatal: { code: event.code, message: event.message, hint: event.hint },
      };
    case "draft.started":
    case "draft.delta":
    case "draft.completed":
      return s; // the draft stream (increment 8) never rides this connection
    default:
      return event satisfies never;
  }
}

function closeOpenSteps(steps: StepView[]): StepView[] {
  return steps.map((step) =>
    step.status === "running"
      ? { ...step, status: "skipped" as const, skip: { kind: "skip" as const, reason: "cancelled" as const } }
      : step,
  );
}
