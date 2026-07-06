import type { Clock } from "@/domain/pipeline/clock";
import { createRunBudget, type CreatedRunBudget } from "@/domain/pipeline/RunBudget";
import { scriptedModel } from "@/domain/synthesis/synthesisTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import type { CleanPage, ContactSourceTried, SourceRef, TierNumber } from "@/shared/schema";
import type { ContactCoverage } from "./ContactSource";
import { PublicSourceContactSurfacer, type PublicSourceDeps } from "./PublicSourceContactSurfacer";

// Shared harness for the providers/contact test files (split by module under
// the ~200-line ceiling), following the extractorTestKit/synthesisTestKit
// pattern.

export const FETCHED_AT = "2026-07-06T12:00:02.000Z";

export function coverageOf(tiers: Partial<Record<TierNumber, SourceRef[]>>): ContactCoverage {
  return {
    tiers: ([0, 1, 2, 3] as const).flatMap((tier) => {
      const sources = tiers[tier];
      return sources ? [{ tier, status: "found" as const, sources }] : [];
    }),
  };
}

export function makePage(url: string, text: string, title = "Acme Robotics"): CleanPage {
  return { kind: "page", url, finalUrl: url, title, text, fetchedAt: FETCHED_AT };
}

const fakeClock: Clock = { now: () => 0 };

/** A real budget on a frozen clock — no timers, deterministic tokens. */
export function contactBudget(maxFetches = 3): CreatedRunBudget {
  return createRunBudget({ maxFetches, deadlineMs: 30_000 }, fakeClock);
}

/** A genuinely spent budget. createRunBudget CLAMPS non-positive maxFetches
 *  up to the default, so "0" cannot express exhaustion — consume instead. */
export function spentBudget(): CreatedRunBudget {
  const budget = contactBudget(1);
  budget.tryAcquire("spent in test setup");
  return budget;
}

export const NO_PEOPLE = { people: [] };

/** A surfacer with recording deps: one scripted no-people extraction, an
 *  empty fetcher, a fresh budget, a live signal, and a tried log. */
export function makeSurfacer(overrides: Partial<PublicSourceDeps> = {}) {
  const tried: ContactSourceTried[] = [];
  const deps: PublicSourceDeps = {
    model: scriptedModel({ extractions: [NO_PEOPLE] }),
    fetcher: new FakePageFetcher(),
    budget: contactBudget(),
    cancel: new AbortController().signal,
    onTried: (entry) => tried.push(entry),
    ...overrides,
  };
  return { surfacer: new PublicSourceContactSurfacer(deps), tried, deps };
}
