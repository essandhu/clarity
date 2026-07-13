import { settleByAbort } from "@/domain/pipeline/cachePeek";
import { repoToProjectEntry } from "@/domain/profile/githubMapping";
import {
  GithubRepoNameSchema,
  GithubUsernameSchema,
  type GithubReposResponse,
  type ImportedEntries,
  type ImportReport,
  type ProjectEntry,
} from "@/shared/schema";
import type { GithubImporter } from "./GithubImporter";
import {
  GITHUB_ACCEPT,
  GRAPHQL_URL,
  languagesUrl,
  parseLanguages,
  parsePinnedNames,
  parseRepoList,
  PINNED_QUERY,
  reposUrl,
  userUrl,
} from "./githubApi";
import type { GithubEtagCache } from "./githubEtagCache";
import { GithubImportError, GithubJsonClient, isGithubImportError, type QuotaContext } from "./githubFetch";

// Official REST API importer (decision 44) — keyless-first (60 req/hr),
// optional fine-grained GITHUB_TOKEN, two-stage lazy: stage A lists (2
// requests + a token-only GraphQL pin query), stage B imports one SERIAL
// /languages request per user-ticked repo with x-ratelimit-remaining
// pre-checks. Model-free and README-free (decision 45). The network
// discipline (headers, timeout, host guard, cache, taxonomy) lives in
// githubFetch.ts; the raw shapes in githubApi.ts (200-line pre-splits).

export interface RestGithubImporterDeps {
  cache: GithubEtagCache;
  fetchImpl?: typeof fetch;
  token?: string;
  mintId?: () => string;
  now?: () => string;
  /** Injectable for the timeout regression tests only. */
  timeoutMs?: number;
}

export class RestGithubImporter implements GithubImporter {
  private readonly client: GithubJsonClient;

  constructor(private readonly deps: RestGithubImporterDeps) {
    this.client = new GithubJsonClient(deps);
  }

  async listRepos(username: string, signal?: AbortSignal): Promise<GithubReposResponse> {
    const login = parseInput(GithubUsernameSchema, username, "GitHub username");
    const ctx: QuotaContext = {};
    await this.client.getJson(userUrl(login), ctx, signal); // existence check (404 -> not_found)
    const repos = parseRepoList((await this.client.getJson(reposUrl(login), ctx, signal)).value);

    // Keyless order is 'stars', labeled honestly — pins are GraphQL/token-
    // only; a failed pin query with a token degrades to 'stars' too.
    let order: GithubReposResponse["order"] = "stars";
    let sorted = [...repos].sort((a, b) => b.stars - a.stars);
    if (this.client.hasToken()) {
      const pinned = parsePinnedNames(
        await this.client.postJson(GRAPHQL_URL, { query: PINNED_QUERY, variables: { login } }, signal),
      );
      if (pinned !== undefined) {
        order = "pinned-first";
        // Matched on fullName: a pin of ANOTHER owner's repo must never
        // crown the user's same-named repo (review C10).
        const rank = new Map(pinned.map((nameWithOwner, i) => [nameWithOwner, i]));
        sorted = [
          ...repos
            .filter((repo) => rank.has(repo.fullName))
            .sort((a, b) => (rank.get(a.fullName) ?? 0) - (rank.get(b.fullName) ?? 0))
            .map((repo) => ({ ...repo, pinned: true })),
          ...repos.filter((repo) => !rank.has(repo.fullName)).sort((a, b) => b.stars - a.stars),
        ];
      }
    }
    // Rate comes from THIS user-initiated call's live headers; a fully-
    // cached run learns it from the quota-free /rate_limit endpoint instead.
    // Health never dials at all (decision 56).
    const rate = ctx.rate ?? (await this.client.fetchRate(signal));
    return { repos: sorted, order, rate };
  }

  async importRepos(
    username: string,
    repoNames: string[],
    signal?: AbortSignal,
  ): Promise<{ entries: ImportedEntries; report: ImportReport }> {
    const login = parseInput(GithubUsernameSchema, username, "GitHub username");
    const names = repoNames.map((name) => parseInput(GithubRepoNameSchema, name, "repository name"));
    const ctx: QuotaContext = {};
    const list = parseRepoList((await this.client.getJson(reposUrl(login), ctx, signal)).value);
    const byName = new Map(list.map((repo) => [repo.name, repo]));
    const importedAt = (this.deps.now ?? (() => new Date().toISOString()))();
    const mintId = this.deps.mintId ?? (() => crypto.randomUUID());

    const projects: ProjectEntry[] = [];
    const notes: string[] = [];
    // SERIAL per GitHub's secondary-limit guidance (§4.6) — the awaited loop
    // is the politeness posture, not an accident.
    for (const name of names) {
      const repo = byName.get(name);
      if (!repo) {
        notes.push(`${login}/${name}: not in the listed repositories — skipped.`);
        continue;
      }
      const url = languagesUrl(login, name);
      // Decision 44's quota honesty: before every LIVE dial, check the last
      // response's remaining (learned from /rate_limit when the plan so far
      // was all cache hits). A fresh cache entry costs nothing — always served.
      const cached = await settleByAbort(
        this.deps.cache.get(url, GITHUB_ACCEPT),
        { kind: "miss" as const },
        signal,
      );
      if (cached.kind !== "fresh") {
        if (ctx.rate === undefined) ctx.rate = await this.client.fetchRate(signal);
        if (ctx.rate.remaining < 1) {
          notes.push(
            `${login}/${name}: skipped — GitHub rate limit exhausted (resets at ${new Date(ctx.rate.reset * 1000).toISOString()}).`,
          );
          continue;
        }
      }
      let languages: Record<string, number>;
      try {
        languages = parseLanguages((await this.client.getJson(url, ctx, signal)).value);
      } catch (err) {
        if (isGithubImportError(err) && err.code === "rate_limited") {
          notes.push(`${login}/${name}: skipped — GitHub rate limit exhausted.`);
          continue;
        }
        throw err;
      }
      projects.push(repoToProjectEntry(repo, languages, { mintId, importedAt }));
    }
    return {
      entries: { experience: [], projects, education: [], skills: [] },
      report: { droppedStrings: [], truncated: false, notes },
    };
  }
}

function parseInput(
  schema: { safeParse(value: string): { success: boolean } },
  value: string,
  label: string,
): string {
  if (!schema.safeParse(value).success) {
    throw new GithubImportError(
      "input_invalid",
      `Not a valid ${label}: ${JSON.stringify(value.slice(0, 60))}`,
    );
  }
  return value;
}

export { GITHUB_FETCH_TIMEOUT_MS, GithubImportError, isGithubImportError } from "./githubFetch";
