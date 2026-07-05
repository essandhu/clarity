import type { ZodType } from "zod";
import type { BudgetToken, RunBudget } from "@/domain/pipeline/RunBudget";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { GenOpts, ModelProvider } from "@/providers/model/ModelProvider";
import type { CleanPage, FetchSkip } from "@/shared/schema";

// Shared stubs for the ListingExtractor test files (split by input path to
// honor the ~200-line ceiling). The eslint layering rule bans provider
// IMPLEMENTATIONS (incl. fakes) from src/domain/**, so these are typed against
// the sanctioned interface files only. Extraction results still go through the
// caller's schema, like the real provider, so a drifting fixture fails loudly.

export function stubModel(results: unknown[]): ModelProvider & {
  calls: { input: string; opts?: GenOpts }[];
} {
  const queue = [...results];
  const calls: { input: string; opts?: GenOpts }[] = [];
  return {
    id: "stub",
    calls,
    async extract<T>(input: string, schema: ZodType<T>, opts?: GenOpts): Promise<T> {
      calls.push({ input, opts });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("stubModel: no scripted result left");
      return schema.parse(next);
    },
    async *streamSynthesis() {
      throw new Error("stubModel: streamSynthesis is not part of Stage 1");
    },
  };
}

export function stubFetcher(result?: CleanPage | FetchSkip): PageFetcher & {
  calls: { url: string; token: BudgetToken }[];
} {
  const calls: { url: string; token: BudgetToken }[] = [];
  return {
    calls,
    async fetchClean(url: string, token: BudgetToken) {
      calls.push({ url, token });
      if (result === undefined) throw new Error("stubFetcher: unexpected fetch");
      return result;
    },
  };
}

export function stubBudget(
  opts: { exhausted?: boolean } = {},
): RunBudget & { labels: string[]; issued: BudgetToken[] } {
  const labels: string[] = [];
  const issued: BudgetToken[] = [];
  return {
    labels,
    issued,
    deadlineSignal: new AbortController().signal,
    remainingMs: () => 60_000,
    fetchesUsed: () => labels.length,
    tryAcquire(label: string) {
      if (opts.exhausted) return null;
      labels.push(label);
      const token = { timeoutMs: 10_000, signal: new AbortController().signal };
      issued.push(token);
      return token;
    },
  };
}

export const SUBMITTED_AT = "2026-07-04T12:00:00.000Z";

/** A minimal schema-valid extraction result; spread and override per test. */
export const extraction = {
  company: "Driftlock",
  role: "Backend Engineer",
  namedTechnologies: [],
};

/** An ATS-hosted CleanPage (both url and finalUrl are greenhouse hosts). */
export const page: CleanPage = {
  kind: "page",
  url: "https://boards.greenhouse.io/tessellate/jobs/1",
  finalUrl: "https://job-boards.greenhouse.io/tessellate/jobs/1",
  title: "Senior Platform Engineer — Tessellate",
  text: "Tessellate builds a geospatial analytics platform. Apply: talent@tessellate.dev",
  fetchedAt: "2026-07-04T11:59:00.000Z",
};
