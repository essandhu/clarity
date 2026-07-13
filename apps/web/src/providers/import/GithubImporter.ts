import type { GithubReposResponse, ImportedEntries, ImportReport } from "@/shared/schema";

// GitHub import seam (PLAN-RESUME.md §4.10) — types only, the PageFetcher
// precedent. Consumed by routes through buildServerDeps, never by domain
// code (decision 55: the ESLint allowlist is deliberately unchanged).

export interface GithubImporter {
  /** Stage A: 2 REST requests (+1 GraphQL pin query iff a token exists). */
  listRepos(username: string, signal?: AbortSignal): Promise<GithubReposResponse>;
  /** Stage B: one SERIAL /languages request per ticked repo, with
   *  x-ratelimit-remaining pre-checks; skipped repos are NAMED in
   *  report.notes (degrade honestly, never silently truncate). */
  importRepos(
    username: string,
    repoNames: string[],
    signal?: AbortSignal,
  ): Promise<{ entries: ImportedEntries; report: ImportReport }>;
}

/** Typed failure taxonomy for the routes' HTTP mapping. `off_host` is the
 *  decision-44 post-fetch guard: a 30x redirect off api.github.com is a
 *  failure, never used. */
export type GithubFailureCode =
  | "not_found"
  | "rate_limited"
  | "unauthorized"
  | "off_host"
  | "network"
  | "api_error"
  | "input_invalid";
