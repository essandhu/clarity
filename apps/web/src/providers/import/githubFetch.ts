import { settleByAbort } from "@/domain/pipeline/cachePeek";
import type { GithubFailureCode } from "./GithubImporter";
import {
  GITHUB_ACCEPT,
  GITHUB_API_HOST,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  parseRateHeaders,
  parseRateLimitBody,
  RATE_LIMIT_URL,
  type GithubRate,
} from "./githubApi";
import type { GithubCacheRecord, GithubEtagCache } from "./githubEtagCache";

// The one GitHub network discipline (§4.6), shared by both importer stages:
// pinned headers on EVERY request (an empty UA gets 403), a 10s timeout per
// dial (no watchdog covers these model-free routes), the decision-44
// post-fetch FINAL-URL host guard, cache-before-dial with byte-exact
// If-None-Match replay, and the typed failure taxonomy. The token rides
// ONLY in the Authorization header (decision 56) — never in cache records,
// bodies, notes, or error messages.

export const GITHUB_FETCH_TIMEOUT_MS = 10_000;

export class GithubImportError extends Error {
  constructor(
    readonly code: GithubFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "GithubImportError";
  }
}
export const isGithubImportError = (err: unknown): err is GithubImportError =>
  err instanceof GithubImportError;

function safeJsonParse(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The routes' HTTP mapping for the taxonomy — one answer, both routes. */
export function githubFailureStatus(code: GithubFailureCode): number {
  switch (code) {
    case "input_invalid":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "unauthorized":
      return 401;
    default:
      return 502; // off_host, network, api_error — upstream trouble
  }
}

export interface QuotaContext {
  rate?: GithubRate; // updated from every LIVE response's headers
}

export interface GithubClientDeps {
  cache: GithubEtagCache;
  fetchImpl?: typeof fetch;
  token?: string;
  /** Injectable for the timeout regression tests only. */
  timeoutMs?: number;
}

export class GithubJsonClient {
  private readonly fetchImpl: typeof fetch;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: GithubClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    const token = deps.token?.trim();
    this.token = token ? token : undefined;
    this.timeoutMs = deps.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
  }

  /** The GET choke point: a 24h-fresh cache entry serves without dialing
   *  (keyless, even a 304 costs quota); a stale etag replays byte-exact as
   *  If-None-Match (W/ preserved); 304 keeps the cached body and refreshes
   *  its clock; 200 validates as JSON BEFORE it writes through — and a
   *  cached body that no longer parses is a MISS, never a throw (the cache
   *  contract; review C0: one malformed 200 must not poison 24h of runs). */
  async getJson(
    url: string,
    ctx: QuotaContext,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; fromCache: boolean }> {
    const cached = await settleByAbort(
      this.deps.cache.get(url, GITHUB_ACCEPT),
      { kind: "miss" as const },
      signal,
    );
    // An unparseable cached body is corrupt: fall through to a LIVE dial
    // (without If-None-Match — a 304 could only re-serve the bad bytes).
    let usable: { record: GithubCacheRecord; value: unknown; fresh: boolean } | undefined;
    if (cached.kind !== "miss") {
      const parsed = safeJsonParse(cached.record.body);
      if (parsed.ok) usable = { record: cached.record, value: parsed.value, fresh: cached.kind === "fresh" };
    }
    if (usable?.fresh) return { value: usable.value, fromCache: true };

    const headers = this.baseHeaders();
    if (usable !== undefined && usable.record.etag !== undefined) {
      headers["If-None-Match"] = usable.record.etag;
    }
    const res = await this.dial(url, { headers }, signal);
    ctx.rate = parseRateHeaders(res.headers) ?? ctx.rate;

    if (res.status === 304 && usable !== undefined) {
      await settleByAbort(
        this.deps.cache.set({ ...usable.record, fetchedAt: new Date().toISOString() }),
        undefined,
        signal,
      );
      return { value: usable.value, fromCache: true };
    }
    if (res.ok) {
      const body = await res.text();
      // Validate FIRST: a 200 whose body is not JSON (captive portal,
      // truncated flush) must surface as the typed api_error and must
      // NEVER be cached.
      const parsed = safeJsonParse(body);
      if (!parsed.ok) {
        throw new GithubImportError("api_error", "GitHub returned unparseable JSON.");
      }
      const etag = res.headers.get("etag");
      await settleByAbort(
        this.deps.cache.set({
          url,
          accept: GITHUB_ACCEPT,
          ...(etag !== null ? { etag } : {}),
          body,
          fetchedAt: new Date().toISOString(),
        }),
        undefined,
        signal,
      );
      return { value: parsed.value, fromCache: false };
    }
    throw this.statusFailure(res);
  }

  /** Uncached POST (the GraphQL pin query). Returns undefined on any
   *  non-OK/undialable response — callers degrade honestly. */
  async postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown | undefined> {
    try {
      const res = await this.dial(
        url,
        {
          method: "POST",
          headers: { ...this.baseHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        signal,
      );
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    }
  }

  /** GET /rate_limit — documented quota-free; never cached. */
  async fetchRate(signal?: AbortSignal): Promise<GithubRate> {
    const res = await this.dial(RATE_LIMIT_URL, { headers: this.baseHeaders() }, signal);
    if (!res.ok) throw this.statusFailure(res);
    const rate = parseRateLimitBody((await res.json()) as unknown);
    if (!rate) {
      throw new GithubImportError("api_error", "GitHub /rate_limit returned an unexpected shape.");
    }
    return rate;
  }

  hasToken(): boolean {
    return this.token !== undefined;
  }

  private async dial(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        redirect: "follow",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new GithubImportError(
        "network",
        `Could not reach api.github.com: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Decision 44: the FINAL URL's host must still be api.github.com — a
    // 30x redirect off-host is discarded unread (the v1 residual-(a) class,
    // closed here).
    let finalHost: string;
    try {
      finalHost = new URL(res.url).host;
    } catch {
      finalHost = "";
    }
    if (finalHost !== GITHUB_API_HOST) {
      throw new GithubImportError(
        "off_host",
        `GitHub response landed on "${finalHost || "an unknown host"}" after redirects — discarded.`,
      );
    }
    return res;
  }

  private baseHeaders(): Record<string, string> {
    return {
      "User-Agent": GITHUB_USER_AGENT,
      Accept: GITHUB_ACCEPT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private statusFailure(res: Response): GithubImportError {
    if (res.status === 404) {
      return new GithubImportError("not_found", "GitHub user or repository not found.");
    }
    if (res.status === 401) {
      return new GithubImportError("unauthorized", "GitHub rejected the configured token.");
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      const reset = Number.parseInt(res.headers.get("x-ratelimit-reset") ?? "", 10);
      const at = Number.isNaN(reset) ? "soon" : new Date(reset * 1000).toISOString();
      return new GithubImportError(
        "rate_limited",
        `GitHub rate limit reached — it resets at ${at}. Add a GITHUB_TOKEN for 5,000 requests/hour.`,
      );
    }
    return new GithubImportError("api_error", `GitHub answered HTTP ${res.status}.`);
  }
}
