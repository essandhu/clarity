import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callWithWatchdog, STALL_HINT, streamWithWatchdog } from "./inactivityWatchdog";

const INACTIVITY_MS = 1_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with the signal's reason when it aborts — how fetch/the AI SDK behave. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
}

describe("callWithWatchdog", () => {
  it("aborts a call that never makes progress and surfaces INTERNAL + stall hint", async () => {
    const result = callWithWatchdog({ inactivityMs: INACTIVITY_MS }, (signal) =>
      abortRejection(signal),
    );
    const assertion = expect(result).rejects.toMatchObject({
      name: "PipelineError",
      code: "INTERNAL",
      hint: STALL_HINT,
    });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    await assertion;
  });

  it("passes through the result of a call that completes in time", async () => {
    const result = callWithWatchdog({ inactivityMs: INACTIVITY_MS }, async () => {
      await sleep(INACTIVITY_MS - 100);
      return 42;
    });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 100);
    await expect(result).resolves.toBe(42);
  });

  it("terminates even when the callee ignores the abort signal entirely", async () => {
    // ai-sdk-ollama's chat path never threads abortSignal into its transport;
    // decision 15 requires the run to terminate regardless.
    const result = callWithWatchdog(
      { inactivityMs: INACTIVITY_MS },
      () => new Promise<never>(() => {}),
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "INTERNAL",
      hint: STALL_HINT,
    });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    await assertion;
  });

  it("gives a fresh window after the callee reports progress (repair re-prompt)", async () => {
    const result = callWithWatchdog(
      { inactivityMs: INACTIVITY_MS },
      async (_signal, progress) => {
        await sleep(INACTIVITY_MS - 100); // first attempt: settles invalid
        progress();
        await sleep(INACTIVITY_MS - 100); // repair attempt: total > one window
        return "repaired";
      },
    );
    await vi.advanceTimersByTimeAsync(2 * (INACTIVITY_MS - 100));
    await expect(result).resolves.toBe("repaired");
  });
});

describe("streamWithWatchdog", () => {
  it("aborts a stream that stalls mid-way, keeping the chunks already yielded", async () => {
    async function* stalling(signal: AbortSignal): AsyncIterable<string> {
      yield "a";
      yield "b";
      await abortRejection(signal);
    }
    const received: string[] = [];
    const run = (async () => {
      for await (const chunk of streamWithWatchdog({ inactivityMs: INACTIVITY_MS }, stalling)) {
        received.push(chunk);
      }
    })();
    const assertion = expect(run).rejects.toMatchObject({ code: "INTERNAL", hint: STALL_HINT });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    await assertion;
    expect(received).toEqual(["a", "b"]);
  });

  it("does NOT abort a slow but progressing stream, even past the inactivity window", async () => {
    const chunkGapMs = INACTIVITY_MS - 100;
    async function* slow(): AsyncIterable<string> {
      for (const chunk of ["a", "b", "c", "d"]) {
        await sleep(chunkGapMs);
        yield chunk;
      }
    }
    const received: string[] = [];
    const run = (async () => {
      for await (const chunk of streamWithWatchdog({ inactivityMs: INACTIVITY_MS }, () => slow())) {
        received.push(chunk);
      }
    })();
    // Total wall time (3600ms) far exceeds the window; per-chunk gaps do not.
    await vi.advanceTimersByTimeAsync(4 * chunkGapMs);
    await run;
    expect(received).toEqual(["a", "b", "c", "d"]);
  });

  it("rethrows a caller abort untouched — user cancel is not a stall", async () => {
    const user = new AbortController();
    async function* source(signal: AbortSignal): AsyncIterable<string> {
      yield "a";
      await abortRejection(signal);
    }
    const received: string[] = [];
    const run = (async () => {
      for await (const chunk of streamWithWatchdog(
        { inactivityMs: INACTIVITY_MS, abortSignal: user.signal },
        source,
      )) {
        received.push(chunk);
      }
    })();
    const cancel = new Error("cancelled by user");
    cancel.name = "AbortError";
    const assertion = expect(run).rejects.toBe(cancel);
    await vi.advanceTimersByTimeAsync(0); // let "a" flow before cancelling
    user.abort(cancel);
    await assertion;
    expect(received).toEqual(["a"]);
  });

  it("terminates a stream whose provider ignores the abort signal entirely", async () => {
    async function* deaf(): AsyncIterable<string> {
      yield "a";
      await new Promise<never>(() => {}); // hung, and deaf to the signal
    }
    const run = (async () => {
      const received: string[] = [];
      for await (const chunk of streamWithWatchdog({ inactivityMs: INACTIVITY_MS }, () =>
        deaf(),
      )) {
        received.push(chunk);
      }
    })();
    const assertion = expect(run).rejects.toMatchObject({ code: "INTERNAL", hint: STALL_HINT });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    await assertion;
  });

  it("surfaces the stall even when the underlying stream ends quietly on abort", async () => {
    // Mimics an SDK that swallows stream errors: on abort it just ends.
    async function* quiet(signal: AbortSignal): AsyncIterable<string> {
      yield "a";
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    const run = (async () => {
      const received: string[] = [];
      for await (const chunk of streamWithWatchdog({ inactivityMs: INACTIVITY_MS }, quiet)) {
        received.push(chunk);
      }
    })();
    const assertion = expect(run).rejects.toMatchObject({ code: "INTERNAL", hint: STALL_HINT });
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    await assertion;
  });
});
