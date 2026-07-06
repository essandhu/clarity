import type { Clock } from "@/domain/pipeline/clock";
import { createRunBudget, type CreatedRunBudget } from "@/domain/pipeline/RunBudget";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import {
  PipelineEventSchema,
  pastedListingRef,
  type CleanPage,
  type EnrichmentResult,
  type ListingProfile,
  type SourceRef,
} from "@/shared/schema";
import { enrichCompany, type EnrichmentEvent } from "./CompanyEnricher";

// Shared harness for the CompanyEnricher test files (split by concern under
// the ~200-line ceiling). Every emitted event is parsed through the wire
// schema, so an enricher that emits anything the protocol can't carry fails
// in these tests, not in a browser. The fetcher is passed IN by each test —
// the eslint fake carve-out covers *.test.ts files only, and this kit stays
// interface-typed like extractorTestKit.

export const SUBMITTED_AT = "2026-07-05T12:00:00.000Z";
export const pastedRef = pastedListingRef(SUBMITTED_AT);

export function makeProfile(overrides: Partial<ListingProfile> = {}): ListingProfile {
  return {
    company: "Acme Robotics",
    role: "Backend Engineer",
    namedTechnologies: [],
    rawText: "Acme Robotics is hiring a backend engineer to own ingestion.",
    domain: "acme.dev",
    ...overrides,
  };
}

export function makePage(url: string, overrides: Partial<CleanPage> = {}): CleanPage {
  return {
    kind: "page",
    url,
    finalUrl: url,
    title: "Acme Robotics",
    text: "Acme Robotics builds warehouse robots for small operators. ".repeat(5),
    fetchedAt: "2026-07-05T12:00:01.000Z",
    ...overrides,
  };
}

export interface EnrichRun {
  events: EnrichmentEvent[];
  result: EnrichmentResult;
  budget: CreatedRunBudget;
}

export async function runEnricher(opts: {
  fetcher: PageFetcher;
  profile?: ListingProfile;
  listingSource?: SourceRef;
  maxFetches?: number;
  deadlineMs?: number;
  clock?: Clock;
  cancel?: AbortSignal;
  /** Pass a pre-created budget to control its epoch (deadline tests jump the
   *  fake clock between budget creation and the enricher run). */
  budget?: CreatedRunBudget;
  runStartedAt?: number;
}): Promise<EnrichRun> {
  const clock = opts.clock ?? { now: () => 1_000 };
  const runStartedAt = opts.runStartedAt ?? clock.now();
  const budget =
    opts.budget ??
    createRunBudget(
      {
        maxFetches: opts.maxFetches ?? 12,
        deadlineMs: opts.deadlineMs ?? 60_000,
        cancel: opts.cancel,
      },
      clock,
    );
  const events: EnrichmentEvent[] = [];
  const result = await enrichCompany(
    opts.profile ?? makeProfile(),
    opts.listingSource ?? pastedRef,
    { fetcher: opts.fetcher },
    {
      budget,
      clock,
      runStartedAt,
      cancel: opts.cancel ?? new AbortController().signal,
      emit: (event) => events.push(PipelineEventSchema.parse(event) as EnrichmentEvent),
    },
  );
  return { events, result, budget };
}

export const ofType = <T extends EnrichmentEvent["type"]>(
  events: EnrichmentEvent[],
  type: T,
): Extract<EnrichmentEvent, { type: T }>[] =>
  events.filter((event): event is Extract<EnrichmentEvent, { type: T }> => event.type === type);
