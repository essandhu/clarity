import type { Clock } from "./clock";

// Run budget mechanics (PLAN.md §4). One acquisition per fetchClean dispatch,
// counted at acquisition, never refunded — a timed-out fetch consumed real
// wall clock; refunds would let one slow host starve the ceiling. Cache hits
// (increment 9) bypass acquisition entirely.
//
// The wall clock is enforced three ways: (a) tryAcquire returns null past the
// deadline; (b) each token's timeoutMs is clamped to the remaining time;
// (c) deadlineSignal aborts in-flight fetches at the deadline. The budget owns
// NO timers — the route adapter arms one real setTimeout and calls
// fireDeadline(); tests jump the injected fake clock and call it directly
// (decision 22: the domain stays timer-free).
//
// The deadline never touches model calls (decision 15) — those are bounded by
// user cancel + the inactivity watchdog instead.

export const DEFAULT_MAX_FETCHES = 12;
export const DEFAULT_DEADLINE_MS = 60_000;
// Server-side ceilings for the env-overridable knobs.
export const MAX_MAX_FETCHES = 20;
export const MAX_DEADLINE_MS = 120_000;
// Per-attempt fetch timeout ceiling; clamped down as the deadline nears.
export const FETCH_TIMEOUT_CEILING_MS = 10_000;

export interface BudgetToken {
  /** min(FETCH_TIMEOUT_CEILING_MS, remainingMs()) at acquisition time. */
  timeoutMs: number;
  /** Aborts at the run deadline (and on user cancel, when one was provided). */
  signal: AbortSignal;
}

export interface RunBudgetConfig {
  maxFetches: number;
  deadlineMs: number;
  /**
   * The user-cancel signal. Composed into every token's signal so fetch calls
   * receive AbortSignal.any([cancel, deadlineSignal]) with the composition in
   * exactly one place (PLAN.md §4 "Run budget mechanics").
   */
  cancel?: AbortSignal;
}

export interface RunBudget {
  /**
   * null ⇒ budget exhausted: the caller records a budget_exhausted skip and
   * dispatches NOTHING. Fetches are counted here, at acquisition.
   */
  tryAcquire(label: string): BudgetToken | null;
  remainingMs(): number;
  fetchesUsed(): number;
  deadlineSignal: AbortSignal;
}

export interface CreatedRunBudget extends RunBudget {
  /** Called by the route adapter's real deadline timer. Idempotent. */
  fireDeadline(): void;
}

// Non-positive / non-finite knobs fall back to the defaults; legal values are
// clamped to the server-side ceilings.
const clampKnob = (value: number, ceiling: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.min(value, ceiling) : fallback;

export function createRunBudget(config: RunBudgetConfig, clock: Clock): CreatedRunBudget {
  const maxFetches = clampKnob(config.maxFetches, MAX_MAX_FETCHES, DEFAULT_MAX_FETCHES);
  const deadlineMs = clampKnob(config.deadlineMs, MAX_DEADLINE_MS, DEFAULT_DEADLINE_MS);
  const startedAt = clock.now();
  const deadline = new AbortController();
  let used = 0;

  const remainingMs = () => Math.max(0, deadlineMs - (clock.now() - startedAt));

  return {
    deadlineSignal: deadline.signal,
    remainingMs,
    fetchesUsed: () => used,
    fireDeadline() {
      if (!deadline.signal.aborted) {
        deadline.abort(new Error(`Run deadline reached after ${deadlineMs} ms.`));
      }
    },
    tryAcquire() {
      if (used >= maxFetches || remainingMs() <= 0 || deadline.signal.aborted) {
        return null;
      }
      used += 1;
      return {
        timeoutMs: Math.min(FETCH_TIMEOUT_CEILING_MS, remainingMs()),
        signal: config.cancel
          ? AbortSignal.any([config.cancel, deadline.signal])
          : deadline.signal,
      };
    },
  };
}
