import { z } from "zod";
import { RepoSummarySchema, type RepoSummary } from "@/shared/schema";

// The raw api.github.com shapes and URL builders (pre-split from
// RestGithubImporter under the 200-line ceiling). Usernames and repo names
// are ALREADY schema-constrained to GitHub's real charsets before these
// builders run; encodeURIComponent is defense-in-depth under that (§4.6).

export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_ACCEPT = "application/vnd.github+json";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "clarity-local-research-tool"; // empty UA gets 403

export const RATE_LIMIT_URL = "https://api.github.com/rate_limit"; // quota-free
export const GRAPHQL_URL = "https://api.github.com/graphql"; // token-only (pins)

export const userUrl = (login: string) =>
  `https://api.github.com/users/${encodeURIComponent(login)}`;
// Stars sort doesn't exist server-side; fork filtering is client-side — both
// per the brief. One page of 100, most-recently-pushed first.
export const reposUrl = (login: string) =>
  `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed`;
export const languagesUrl = (login: string, repo: string) =>
  `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/languages`;

// nameWithOwner, not name: pins can reference OTHER owners' repos, and a
// bare-name match could crown the user's same-named repo (review C10).
export const PINNED_QUERY =
  "query($login:String!){user(login:$login){pinnedItems(first:6,types:[REPOSITORY]){nodes{... on Repository{nameWithOwner}}}}}";

const RawRepoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  stargazers_count: z.number().int().nonnegative(),
  pushed_at: z.string().nullable().optional(), // null on empty repos
  fork: z.boolean(),
  archived: z.boolean(),
  html_url: z.string(),
});

/** Raw /users/{u}/repos JSON -> RepoSummary[]. Individually defensive: one
 *  odd entry (or an empty repo with pushed_at: null — nothing to import) is
 *  skipped, never a thrown 100-repo failure. */
export function parseRepoList(value: unknown): RepoSummary[] {
  if (!Array.isArray(value)) return [];
  const repos: RepoSummary[] = [];
  for (const item of value) {
    const raw = RawRepoSchema.safeParse(item);
    if (!raw.success || typeof raw.data.pushed_at !== "string") continue;
    const summary = RepoSummarySchema.safeParse({
      fullName: raw.data.full_name,
      name: raw.data.name,
      ...(raw.data.description != null ? { description: raw.data.description } : {}),
      topics: raw.data.topics ?? [],
      stars: raw.data.stargazers_count,
      pushedAt: raw.data.pushed_at,
      fork: raw.data.fork,
      archived: raw.data.archived,
      htmlUrl: raw.data.html_url,
    });
    if (summary.success) repos.push(summary.data);
  }
  return repos;
}

const LanguagesSchema = z.record(z.string(), z.number().int().nonnegative());

export function parseLanguages(value: unknown): Record<string, number> {
  const parsed = LanguagesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export interface GithubRate {
  limit: number;
  remaining: number;
  reset: number;
}

export function parseRateHeaders(headers: Headers): GithubRate | undefined {
  const limit = Number.parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
  const remaining = Number.parseInt(headers.get("x-ratelimit-remaining") ?? "", 10);
  const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  if ([limit, remaining, reset].some(Number.isNaN)) return undefined;
  return { limit, remaining, reset };
}

const RateLimitBodySchema = z.object({
  resources: z.object({
    core: z.object({
      limit: z.number().int(),
      remaining: z.number().int(),
      reset: z.number().int(),
    }),
  }),
});

export function parseRateLimitBody(value: unknown): GithubRate | undefined {
  const parsed = RateLimitBodySchema.safeParse(value);
  return parsed.success ? parsed.data.resources.core : undefined;
}

const PinnedBodySchema = z.object({
  data: z.object({
    user: z.object({
      pinnedItems: z.object({ nodes: z.array(z.object({ nameWithOwner: z.string() })) }),
    }),
  }),
});

/** Pinned repos as owner/name strings — matched against RepoSummary.fullName. */
export function parsePinnedNames(value: unknown): string[] | undefined {
  const parsed = PinnedBodySchema.safeParse(value);
  return parsed.success
    ? parsed.data.data.user.pinnedItems.nodes.map((node) => node.nameWithOwner)
    : undefined;
}
