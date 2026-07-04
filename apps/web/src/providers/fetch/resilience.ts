import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
  type CircuitBreakerPolicy,
} from "cockatiel";
import type { FetchSkip } from "@/shared/schema";
import { isAbortError } from "@/domain/pipeline/errors";

// Cockatiel composition (PLAN.md decision 10): wrap() is first-arg-outermost,
// so wrap(breaker, retry) gives a per-origin breaker that counts ONE failure
// per exhausted retry sequence. The per-attempt timeout runs INSIDE the
// host-limiter queue slot (see runFetchAttempts): politeness wait is never
// billed to the host, so an honored Crawl-delay at or above the attempt
// budget cannot fabricate `timeout` skips for queued same-host fetches.
//
// Outer cancellation (user cancel / run deadline) is rethrown as
// OuterAbortError, which retry and breaker are configured NOT to handle: a
// cancelled run neither burns retry attempts nor poisons a healthy origin's
// circuit (verified empirically — an unfiltered breaker counts aborts as
// failures and opens after 5 cancelled executes).

// cockatiel's maxAttempts counts RETRIES after the first failure (verified
// empirically), so the plan's `maxAttempts: 2` means up to 3 attempts/fetch.
export const RETRY_MAX_ATTEMPTS = 2;
export const ATTEMPTS_PER_FETCH = RETRY_MAX_ATTEMPTS + 1;
export const BREAKER_CONSECUTIVE_FAILURES = 5;
export const BREAKER_HALF_OPEN_AFTER_MS = 30_000;

// Failure modes detected inside a fetch attempt, thrown through the policy
// (retried as transient) and mapped to typed skips at the boundary.
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

export class NotHtmlError extends Error {
  constructor(readonly contentType: string) {
    super(`not HTML: ${contentType || "(no content-type)"}`);
    this.name = "NotHtmlError";
  }
}

export class TooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`body exceeds ${limitBytes} bytes`);
    this.name = "TooLargeError";
  }
}

/** Outer-signal cancellation — excluded from retry and breaker accounting. */
class OuterAbortError extends Error {
  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : "aborted");
    this.name = "OuterAbortError";
  }
}

const handleTransient = handleWhen((err) => !(err instanceof OuterAbortError));

// Breakers are stateful and MUST be shared per-origin across calls; a Map on
// globalThis (keyed with Symbol.for) survives Next dev-mode HMR module
// reloads (PLAN.md risk 11).
const BREAKERS_KEY = Symbol.for("clarity.fetch.breakers");
const globalStore = globalThis as { [BREAKERS_KEY]?: Map<string, CircuitBreakerPolicy> };

function breakerForOrigin(origin: string): CircuitBreakerPolicy {
  const breakers = (globalStore[BREAKERS_KEY] ??= new Map());
  let breaker = breakers.get(origin);
  if (!breaker) {
    breaker = circuitBreaker(handleTransient, {
      halfOpenAfter: BREAKER_HALF_OPEN_AFTER_MS,
      breaker: new ConsecutiveBreaker(BREAKER_CONSECUTIVE_FAILURES),
    });
    breakers.set(origin, breaker);
  }
  return breaker;
}

export interface FetchAttemptPlan<T> {
  origin: string;
  attemptTimeoutMs: number;
  /** User cancel and/or run deadline, already composed by the BudgetToken. */
  outerSignal: AbortSignal;
  /** Politeness queue (host limiter). Retry attempts re-enter it. */
  queue?: (run: () => Promise<T>) => Promise<T>;
  /** One bounded network attempt; MUST thread the given signal into fetch. */
  attempt: (signal: AbortSignal) => Promise<T>;
}

/**
 * breaker(retry(queue(timeout(attempt)))) — the one composed execution path
 * for every network fetch (pages and robots.txt alike).
 */
export async function runFetchAttempts<T>(plan: FetchAttemptPlan<T>): Promise<T> {
  const { origin, attemptTimeoutMs, outerSignal, attempt } = plan;
  const queue = plan.queue ?? ((run) => run());
  const policy = wrap(
    breakerForOrigin(origin),
    retry(handleTransient, { maxAttempts: RETRY_MAX_ATTEMPTS, backoff: new ExponentialBackoff() }),
  );
  return policy.execute((ctx) => {
    const pending = queue(async () => {
      // The wait for this queue slot may have outlived the run.
      if (ctx.signal.aborted) throw new OuterAbortError(ctx.signal.reason);
      try {
        // The attempt clock starts HERE, inside the politeness slot.
        return await timeout(attemptTimeoutMs, TimeoutStrategy.Aggressive).execute(
          (timeoutCtx) => attempt(timeoutCtx.signal),
          ctx.signal,
        );
      } catch (err) {
        // Outer abort and attempt timeout both surface as cancellation-shaped
        // errors; only the outer signal tells them apart.
        if (outerSignal.aborted) throw new OuterAbortError(outerSignal.reason);
        throw err;
      }
    });
    // Pre-observe: if this queued job settles after the policy already gave
    // up on it, that must never surface as an unhandled rejection.
    pending.catch(() => {});
    return pending;
  }, outerSignal);
}

/**
 * Boundary mapping: whatever escaped the policy becomes a typed FetchSkip —
 * fetchClean never throws into the pipeline (decision 21).
 *
 * The outer signal is checked FIRST: a user-cancel/deadline abort must never
 * be mislabelled as a host timeout.
 */
export function errorToSkip(err: unknown, url: string, outerSignal: AbortSignal): FetchSkip {
  if (outerSignal.aborted) {
    const reason = outerSignal.reason;
    return {
      kind: "skip",
      url,
      reason: "cancelled",
      detail: reason instanceof Error ? reason.message : "aborted",
    };
  }
  if (err instanceof BrokenCircuitError) {
    return {
      kind: "skip",
      url,
      reason: "circuit_open",
      detail: `circuit open after ${BREAKER_CONSECUTIVE_FAILURES} consecutive failures on this origin`,
    };
  }
  // An aggressive timeout surfaces EITHER as cockatiel's TaskCancelledError
  // or as the aborted fetch's own AbortError — whichever settles first. The
  // outer signal was checked above, so an abort here can only mean the
  // per-attempt timeout fired.
  if (err instanceof TaskCancelledError || isAbortError(err)) {
    return {
      kind: "skip",
      url,
      reason: "timeout",
      detail: err instanceof Error ? err.message : "attempt timed out",
    };
  }
  if (err instanceof HttpStatusError) {
    return { kind: "skip", url, reason: "http_status", httpStatus: err.status, detail: err.message };
  }
  if (err instanceof NotHtmlError) {
    return { kind: "skip", url, reason: "not_html", detail: err.message };
  }
  if (err instanceof TooLargeError) {
    return { kind: "skip", url, reason: "too_large", detail: err.message };
  }
  const detail =
    err instanceof Error
      ? [err.message, err.cause instanceof Error ? err.cause.message : null]
          .filter(Boolean)
          .join(": ")
      : String(err);
  return { kind: "skip", url, reason: "network", detail };
}
