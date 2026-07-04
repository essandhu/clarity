import { BrokenCircuitError, TaskCancelledError } from "cockatiel";
import { describe, expect, it } from "vitest";
import {
  ATTEMPTS_PER_FETCH,
  BREAKER_CONSECUTIVE_FAILURES,
  errorToSkip,
  HttpStatusError,
  NotHtmlError,
  runFetchAttempts,
  TooLargeError,
} from "./resilience";

const URL_ = "https://resilience.test/page";
const liveSignal = () => new AbortController().signal;

const run = <T>(
  origin: string,
  attempt: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number; outerSignal?: AbortSignal; queue?: (r: () => Promise<T>) => Promise<T> } = {},
) =>
  runFetchAttempts({
    origin,
    attemptTimeoutMs: opts.timeoutMs ?? 5_000,
    outerSignal: opts.outerSignal ?? liveSignal(),
    queue: opts.queue,
    attempt,
  });

const hangingAttempt = (onCall?: () => void) => (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    onCall?.();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("errorToSkip — every failure mode maps to a typed skip", () => {
  it.each([
    [new BrokenCircuitError(), "circuit_open"],
    [new TaskCancelledError("Operation timed out after 50ms"), "timeout"],
    [new HttpStatusError(404), "http_status"],
    [new NotHtmlError("application/pdf"), "not_html"],
    [new TooLargeError(2_097_152), "too_large"],
    [new TypeError("fetch failed"), "network"],
    ["a thrown string", "network"],
  ] as const)("%o → %s", (err, reason) => {
    const skip = errorToSkip(err, URL_, liveSignal());
    expect(skip).toMatchObject({ kind: "skip", url: URL_, reason });
  });

  it("carries the HTTP status on http_status skips", () => {
    expect(errorToSkip(new HttpStatusError(503), URL_, liveSignal()).httpStatus).toBe(503);
  });

  it("surfaces a network error's cause in the detail", () => {
    const err = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    expect(errorToSkip(err, URL_, liveSignal()).detail).toContain("ENOTFOUND");
  });

  it("an aborted outer signal wins over every error shape — never mislabelled", () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled the run"));
    // Even a timeout-shaped error maps to `cancelled` when the outer signal
    // (user cancel or run deadline) fired: that is what ended the fetch.
    const skip = errorToSkip(new TaskCancelledError("timed out"), URL_, controller.signal);
    expect(skip.reason).toBe("cancelled");
    expect(skip.detail).toContain("user cancelled");
  });
});

describe("runFetchAttempts — breaker(retry(queue(timeout(attempt))))", () => {
  it("re-attempts a failing fetch up to the retry budget", async () => {
    let calls = 0;
    await expect(
      run("https://retry-1.test", async () => {
        calls += 1;
        throw new HttpStatusError(500);
      }),
    ).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toBe(ATTEMPTS_PER_FETCH);
  });

  it("aggressively times out a hung attempt, and the escape maps to a timeout skip", async () => {
    let calls = 0;
    const err: unknown = await run("https://hang-1.test", hangingAttempt(() => (calls += 1)), {
      timeoutMs: 60,
    })
      .then(() => expect.unreachable("a hung attempt must not resolve"))
      .catch((e: unknown) => e);
    // The race between cockatiel's TaskCancelledError and the aborted fn's
    // own AbortError can settle either way — the CONTRACT is the skip label.
    expect(errorToSkip(err, URL_, liveSignal()).reason).toBe("timeout");
    expect(calls).toBe(ATTEMPTS_PER_FETCH); // every attempt hung and timed out
  });

  it("does NOT bill politeness-queue wait to the attempt timeout", async () => {
    // Queue wait (300ms) far exceeds the attempt budget (100ms); the attempt
    // itself is instant — it must succeed because its clock starts in-slot.
    const delayedQueue = (job: () => Promise<string>) =>
      new Promise<string>((resolve, reject) => {
        setTimeout(() => job().then(resolve, reject), 300);
      });
    await expect(
      run("https://queue-wait.test", async () => "fetched", {
        timeoutMs: 100,
        queue: delayedQueue,
      }),
    ).resolves.toBe("fetched");
  });

  it("opens the per-origin circuit after consecutive exhausted retry sequences", async () => {
    const origin = "https://breaker-1.test";
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new HttpStatusError(500);
    };
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES; i++) {
      await expect(run(origin, failing)).rejects.toBeInstanceOf(HttpStatusError);
    }
    // One breaker failure per exhausted retry sequence, not per attempt:
    // 5 sequences × 3 attempts ran before the circuit opened.
    expect(calls).toBe(BREAKER_CONSECUTIVE_FAILURES * ATTEMPTS_PER_FETCH);
    await expect(run(origin, failing)).rejects.toBeInstanceOf(BrokenCircuitError);
    expect(calls).toBe(BREAKER_CONSECUTIVE_FAILURES * ATTEMPTS_PER_FETCH); // open circuit: no dispatch
  });

  it("keeps breaker state per origin — one bad host never trips another", async () => {
    const failing = async () => {
      throw new HttpStatusError(500);
    };
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES; i++) {
      await expect(run("https://breaker-bad.test", failing)).rejects.toThrow();
    }
    let healthyCalls = 0;
    await expect(
      run("https://breaker-good.test", async () => {
        healthyCalls += 1;
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(healthyCalls).toBe(1);
  });

  it("stops (no further attempts) once the outer signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = run("https://cancel-1.test", hangingAttempt(() => (calls += 1)), {
      outerSignal: controller.signal,
    });
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow();
    // Give any (incorrect) retry a moment to fire before asserting.
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(1);
  });

  it("cancelled runs do not count toward the breaker — no healthy-origin poisoning", async () => {
    const origin = "https://cancel-immune.test";
    // More cancelled sequences than the breaker threshold…
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES + 2; i++) {
      const controller = new AbortController();
      const pending = run(origin, hangingAttempt(), { outerSignal: controller.signal });
      controller.abort(new Error("user cancelled"));
      await pending.catch(() => {});
    }
    // …and the circuit must still be closed for the next healthy call.
    await expect(run(origin, async () => "healthy")).resolves.toBe("healthy");
  });
});
