import { describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import {
  createRunBudget,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_FETCHES,
  FETCH_TIMEOUT_CEILING_MS,
  MAX_DEADLINE_MS,
  MAX_MAX_FETCHES,
} from "./RunBudget";

class FakeClock implements Clock {
  private t = 0;
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

const config = { maxFetches: 3, deadlineMs: 60_000 };

describe("createRunBudget — fetch counter", () => {
  it("issues tokens up to maxFetches, then null, counting at acquisition", () => {
    const budget = createRunBudget(config, new FakeClock());
    expect(budget.tryAcquire("a")).not.toBeNull();
    expect(budget.tryAcquire("b")).not.toBeNull();
    expect(budget.tryAcquire("c")).not.toBeNull();
    expect(budget.fetchesUsed()).toBe(3);
    expect(budget.tryAcquire("d")).toBeNull();
    // A refused acquisition is not counted (and nothing is ever refunded).
    expect(budget.fetchesUsed()).toBe(3);
  });

  it("clamps maxFetches to the server-side ceiling", () => {
    const budget = createRunBudget({ ...config, maxFetches: 999 }, new FakeClock());
    for (let i = 0; i < MAX_MAX_FETCHES; i++) {
      expect(budget.tryAcquire(`fetch-${i}`)).not.toBeNull();
    }
    expect(budget.tryAcquire("over")).toBeNull();
  });

  it("falls back to defaults on non-positive / non-finite knobs", () => {
    const clock = new FakeClock();
    const budget = createRunBudget({ maxFetches: 0, deadlineMs: Number.NaN }, clock);
    for (let i = 0; i < DEFAULT_MAX_FETCHES; i++) {
      expect(budget.tryAcquire(`fetch-${i}`)).not.toBeNull();
    }
    expect(budget.tryAcquire("over")).toBeNull();
    expect(budget.remainingMs()).toBe(DEFAULT_DEADLINE_MS);
  });
});

describe("createRunBudget — wall-clock deadline (fake clock, no sleeping)", () => {
  it("reports remaining time and clamps it at zero past the deadline", () => {
    const clock = new FakeClock();
    const budget = createRunBudget(config, clock);
    expect(budget.remainingMs()).toBe(60_000);
    clock.advance(45_000);
    expect(budget.remainingMs()).toBe(15_000);
    clock.advance(30_000);
    expect(budget.remainingMs()).toBe(0);
  });

  it("refuses acquisition past the deadline even with fetches left", () => {
    const clock = new FakeClock();
    const budget = createRunBudget(config, clock);
    clock.advance(60_000);
    expect(budget.tryAcquire("late")).toBeNull();
    expect(budget.fetchesUsed()).toBe(0);
  });

  it("clamps deadlineMs to the server-side ceiling", () => {
    const clock = new FakeClock();
    const budget = createRunBudget({ ...config, deadlineMs: 999_999 }, clock);
    expect(budget.remainingMs()).toBe(MAX_DEADLINE_MS);
    clock.advance(MAX_DEADLINE_MS);
    expect(budget.tryAcquire("late")).toBeNull();
  });

  it("caps token timeoutMs at the ceiling while time is plentiful", () => {
    const budget = createRunBudget(config, new FakeClock());
    expect(budget.tryAcquire("a")?.timeoutMs).toBe(FETCH_TIMEOUT_CEILING_MS);
  });

  it("clamps token timeoutMs to the remaining time near the deadline", () => {
    const clock = new FakeClock();
    const budget = createRunBudget(config, clock);
    clock.advance(55_000);
    expect(budget.tryAcquire("late")?.timeoutMs).toBe(5_000);
  });
});

describe("createRunBudget — deadline signal", () => {
  it("stays timer-free: the signal fires only when the adapter calls fireDeadline", () => {
    const clock = new FakeClock();
    const budget = createRunBudget(config, clock);
    clock.advance(120_000); // way past the deadline — still no abort by itself
    expect(budget.deadlineSignal.aborted).toBe(false);
    budget.fireDeadline();
    expect(budget.deadlineSignal.aborted).toBe(true);
  });

  it("aborts already-issued tokens and refuses new ones after fireDeadline", () => {
    const budget = createRunBudget(config, new FakeClock());
    const token = budget.tryAcquire("in-flight");
    expect(token?.signal.aborted).toBe(false);
    budget.fireDeadline();
    expect(token?.signal.aborted).toBe(true);
    expect(budget.tryAcquire("after")).toBeNull();
  });

  it("fireDeadline is idempotent and carries a reason", () => {
    const budget = createRunBudget(config, new FakeClock());
    budget.fireDeadline();
    const reason = budget.deadlineSignal.reason as Error;
    budget.fireDeadline();
    expect(budget.deadlineSignal.reason).toBe(reason);
    expect(reason.message).toMatch(/deadline/i);
  });
});

describe("createRunBudget — user-cancel composition", () => {
  it("composes cancel into token signals without touching the deadline signal", () => {
    const cancel = new AbortController();
    const budget = createRunBudget({ ...config, cancel: cancel.signal }, new FakeClock());
    const token = budget.tryAcquire("a");
    expect(token?.signal.aborted).toBe(false);
    cancel.abort();
    expect(token?.signal.aborted).toBe(true);
    expect(budget.deadlineSignal.aborted).toBe(false);
  });

  it("token signals still fire on the deadline when a cancel signal is present", () => {
    const cancel = new AbortController();
    const budget = createRunBudget({ ...config, cancel: cancel.signal }, new FakeClock());
    const token = budget.tryAcquire("a");
    budget.fireDeadline();
    expect(token?.signal.aborted).toBe(true);
  });
});
