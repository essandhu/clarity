import { PipelineError } from "@/domain/pipeline/errors";

// Progress-reset abort timer around model calls (PLAN.md decision 15). The
// wall-clock deadline never touches model calls; instead, a call that makes NO
// progress (no delta, no completion) for `inactivityMs` is aborted and
// surfaces as the fatal INTERNAL error with a stall hint — so a hung provider
// stream is bounded even if nobody is watching. Progress resets the timer, so
// a slow-but-progressing local model is never killed.
//
// The stall error travels as the abort signal's REASON. Every await here also
// races against that signal because not every provider implementation threads
// abortSignal into its transport (ai-sdk-ollama's chat path ignores it
// entirely) — decision 15 requires the RUN to terminate regardless; a
// non-cooperating provider's request may leak, but the run does not hang.

export const DEFAULT_INACTIVITY_MS = 300_000;

export const STALL_HINT =
  "The model stream stalled — check that Ollama is running / your provider status page.";

export interface WatchdogOpts {
  inactivityMs: number;
  /** The caller's own signal (user cancel); composed with the stall timer. */
  abortSignal?: AbortSignal;
}

interface Watchdog {
  signal: AbortSignal;
  progress(): void;
  stalled(): boolean;
  dispose(): void;
}

function stallError(inactivityMs: number): PipelineError {
  return new PipelineError(
    "INTERNAL",
    `Model call made no progress for ${inactivityMs} ms and was aborted.`,
    { hint: STALL_HINT },
  );
}

function startWatchdog({ inactivityMs, abortSignal }: WatchdogOpts): Watchdog {
  const controller = new AbortController();
  let stalled = false;
  const fire = () => {
    stalled = true;
    controller.abort(stallError(inactivityMs));
  };
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, inactivityMs);
  return {
    signal: abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal,
    progress() {
      if (timer !== undefined && !stalled) {
        clearTimeout(timer);
        timer = setTimeout(fire, inactivityMs);
      }
    },
    stalled: () => stalled,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Rejects with the signal's reason when it fires; never resolves. */
function rejectionOn(signal: AbortSignal): Promise<never> {
  const rejection = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
  // Pre-observe so losing a Promise.race never surfaces as an unhandled rejection.
  rejection.catch(() => {});
  return rejection;
}

/**
 * Wraps a promise-shaped model call (extract). The call receives a `progress`
 * callback so multi-step calls (the repair re-prompt) can reset the window on
 * intermediate completions; otherwise the timer is a ceiling on the whole call.
 */
export async function callWithWatchdog<T>(
  opts: WatchdogOpts,
  call: (signal: AbortSignal, progress: () => void) => Promise<T>,
): Promise<T> {
  const watchdog = startWatchdog(opts);
  try {
    const pending = call(watchdog.signal, () => watchdog.progress());
    pending.catch(() => {}); // pre-observe: it may settle after losing the race
    return await Promise.race([pending, rejectionOn(watchdog.signal)]);
  } finally {
    watchdog.dispose();
  }
}

/**
 * Wraps a stream-shaped model call (streamSynthesis, draft). Every yielded
 * chunk resets the timer.
 */
export async function* streamWithWatchdog(
  opts: WatchdogOpts,
  start: (signal: AbortSignal) => AsyncIterable<string>,
): AsyncIterable<string> {
  const watchdog = startWatchdog(opts);
  const iterator = start(watchdog.signal)[Symbol.asyncIterator]();
  const aborted = rejectionOn(watchdog.signal);
  try {
    for (;;) {
      const step = iterator.next();
      step.catch(() => {}); // pre-observe: it may settle after losing the race
      const result = await Promise.race([step, aborted]);
      if (result.done) break;
      watchdog.progress();
      yield result.value;
    }
    // Some SDK streams end quietly on abort instead of throwing; a stalled
    // stream must still surface the fatal error, never a silent completion.
    if (watchdog.stalled()) throw stallError(opts.inactivityMs);
  } finally {
    watchdog.dispose();
    // Close the inner stream without awaiting it — a hung provider would
    // otherwise block teardown forever.
    iterator.return?.()?.catch(() => {});
  }
}
