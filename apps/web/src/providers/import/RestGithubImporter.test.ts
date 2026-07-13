import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubReposResponseSchema, ImportedEntriesSchema } from "@/shared/schema";
import { GithubEtagCache } from "./githubEtagCache";
import { isGithubImportError } from "./githubFetch";
import { RestGithubImporter } from "./RestGithubImporter";

// Injected-fetch-fake coverage for §7.12: pinned headers (the empty-UA-403
// class), byte-exact If-None-Match replay incl. W/, fresh-cache zero-dial,
// keyless quota stop naming skipped repos, the decision-44 off-host redirect
// rejection, SERIAL stage B, and the decision-56 token-leak scan.

const USER_URL = "https://api.github.com/users/octocat";
const REPOS_URL = "https://api.github.com/users/octocat/repos?per_page=100&sort=pushed";
const RATE_URL = "https://api.github.com/rate_limit";
const langUrl = (repo: string) => `https://api.github.com/repos/octocat/${repo}/languages`;

const HOUR_MS = 60 * 60 * 1000;
const iso = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();

function rawRepo(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    full_name: `octocat/${name}`,
    description: `The ${name} repo`,
    topics: ["testing"],
    stargazers_count: 5,
    pushed_at: "2026-01-02T03:04:05Z",
    fork: false,
    archived: false,
    html_url: `https://github.com/octocat/${name}`,
    watchers: 5, // extra fields must be ignored
    ...over,
  };
}

function respond(
  url: string,
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const status = init?.status ?? 200;
  const res = new Response(
    status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: init?.headers },
  );
  Object.defineProperty(res, "url", { value: url });
  return res;
}

type Recorded = { url: string; init: RequestInit | undefined };

function fetchFake(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  log: Recorded[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const headerOf = (record: Recorded, name: string): string | undefined =>
  (record.init?.headers as Record<string, string> | undefined)?.[name];

const okRate = { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1750000000" };

describe("RestGithubImporter", () => {
  let dir: string;
  let cache: GithubEtagCache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "clarity-github-"));
    cache = new GithubEtagCache(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stageAHandler = (url: string): Response => {
    if (url === USER_URL) return respond(url, { login: "octocat" }, { headers: okRate });
    if (url === REPOS_URL) {
      return respond(
        url,
        [
          rawRepo("alpha", { stargazers_count: 1 }),
          rawRepo("beta", { stargazers_count: 9, description: null, topics: undefined }),
          rawRepo("empty", { pushed_at: null }), // nothing to import — filtered
        ],
        { headers: { ...okRate, etag: 'W/"list-v1"' } },
      );
    }
    throw new Error(`unexpected url ${url}`);
  };

  it("stage A keyless: exactly 2 requests, pinned headers, no Authorization, stars order", async () => {
    const log: Recorded[] = [];
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(stageAHandler, log) });
    const result = await importer.listRepos("octocat");

    expect(log.map((r) => r.url)).toEqual([USER_URL, REPOS_URL]);
    for (const record of log) {
      expect(headerOf(record, "User-Agent")).toBe("clarity-local-research-tool");
      expect(headerOf(record, "Accept")).toBe("application/vnd.github+json");
      expect(headerOf(record, "X-GitHub-Api-Version")).toBe("2022-11-28");
      expect(headerOf(record, "Authorization")).toBeUndefined();
    }
    expect(GithubReposResponseSchema.parse(result)).toBeTruthy();
    expect(result.order).toBe("stars");
    expect(result.repos.map((r) => r.name)).toEqual(["beta", "alpha"]); // stars desc, empty filtered
    expect(result.repos[1]?.description).toBe("The alpha repo");
    expect(result.repos[0]?.description).toBeUndefined(); // null -> absent
    expect(result.rate).toEqual({ limit: 60, remaining: 42, reset: 1750000000 });
  });

  it("with a token: Bearer on every request, pinned repos lead by FULL NAME, order labeled pinned-first", async () => {
    const log: Recorded[] = [];
    const handler = (url: string, init: RequestInit | undefined): Response => {
      if (url === "https://api.github.com/graphql") {
        expect(init?.method).toBe("POST");
        // The second pin references ANOTHER owner's repo that shares the
        // bare name "beta" — it must not crown octocat/beta (review C10).
        return respond(url, {
          data: {
            user: {
              pinnedItems: {
                nodes: [{ nameWithOwner: "octocat/alpha" }, { nameWithOwner: "stranger/beta" }],
              },
            },
          },
        });
      }
      return stageAHandler(url);
    };
    const importer = new RestGithubImporter({
      cache,
      fetchImpl: fetchFake(handler, log),
      token: "ghp_TESTTOKEN",
    });
    const result = await importer.listRepos("octocat");
    expect(result.order).toBe("pinned-first");
    expect(result.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(result.repos[0]?.pinned).toBe(true);
    expect(result.repos[1]?.pinned).toBeUndefined(); // stranger/beta is not octocat/beta
    for (const record of log) expect(headerOf(record, "Authorization")).toBe("Bearer ghp_TESTTOKEN");
  });

  it("replays a stale etag byte-exact (W/ preserved) and serves the cached body on 304", async () => {
    await cache.set({
      url: USER_URL,
      accept: "application/vnd.github+json",
      etag: 'W/"user-v7"',
      body: JSON.stringify({ login: "octocat" }),
      fetchedAt: iso(-25 * HOUR_MS), // stale, beyond the 24h TTL
    });
    const log: Recorded[] = [];
    const handler = (url: string): Response => {
      if (url === USER_URL) return respond(url, null, { status: 304, headers: okRate });
      return stageAHandler(url);
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, log) });
    await importer.listRepos("octocat");

    const userDial = log.find((r) => r.url === USER_URL);
    expect(headerOf(userDial!, "If-None-Match")).toBe('W/"user-v7"');
    // The 304 refreshed the record's clock: a second lookup is fresh again.
    expect((await cache.get(USER_URL, "application/vnd.github+json")).kind).toBe("fresh");
  });

  it("24h-fresh cache serves stage A with zero quota-bearing dials (only free /rate_limit)", async () => {
    const accept = "application/vnd.github+json";
    await cache.set({ url: USER_URL, accept, body: JSON.stringify({ login: "octocat" }), fetchedAt: iso(-HOUR_MS) });
    await cache.set({
      url: REPOS_URL,
      accept,
      body: JSON.stringify([rawRepo("alpha")]),
      fetchedAt: iso(-HOUR_MS),
    });
    const log: Recorded[] = [];
    const handler = (url: string): Response => {
      if (url === RATE_URL) {
        return respond(url, { resources: { core: { limit: 60, remaining: 60, reset: 1750000000 } } });
      }
      throw new Error(`unexpected dial ${url}`);
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, log) });
    const result = await importer.listRepos("octocat");
    expect(result.repos.map((r) => r.name)).toEqual(["alpha"]);
    expect(log.map((r) => r.url)).toEqual([RATE_URL]); // rate is required; /rate_limit is quota-free
    expect(result.rate.remaining).toBe(60);
  });

  it("keyless quota stop mid-stage-B: remaining repos skipped and NAMED, never dialed", async () => {
    const log: Recorded[] = [];
    const handler = (url: string): Response => {
      if (url === REPOS_URL) {
        return respond(url, [rawRepo("one"), rawRepo("two"), rawRepo("three")], {
          headers: { ...okRate, "x-ratelimit-remaining": "1" },
        });
      }
      if (url === langUrl("one")) {
        return respond(url, { TypeScript: 100 }, { headers: { ...okRate, "x-ratelimit-remaining": "0" } });
      }
      throw new Error(`unexpected dial ${url}`);
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, log) });
    const { entries, report } = await importer.importRepos("octocat", ["one", "two", "three"]);

    expect(entries.projects.map((p) => p.name)).toEqual(["one"]);
    expect(report.notes).toHaveLength(2);
    expect(report.notes[0]).toContain("octocat/two");
    expect(report.notes[1]).toContain("octocat/three");
    expect(report.notes[0]).toContain("rate limit");
    expect(log.map((r) => r.url)).toEqual([REPOS_URL, langUrl("one")]); // two and three never dialed
    expect(ImportedEntriesSchema.parse(entries)).toBeTruthy();
  });

  it("a 200 whose body is not JSON is the typed api_error and is NEVER cached (review C0)", async () => {
    const importer = new RestGithubImporter({
      cache,
      fetchImpl: fetchFake((url) => respond(url, "<html>captive portal</html>", { headers: okRate }), []),
    });
    const failure = await importer.listRepos("octocat").catch((err: unknown) => err);
    expect(isGithubImportError(failure) && failure.code === "api_error").toBe(true);
    await expect(readdir(dir).catch(() => [])).resolves.toEqual([]); // nothing poisoned the cache
  });

  it("a schema-valid cache record whose body is not JSON is a MISS — live redial, no If-None-Match, never a throw (review C0)", async () => {
    await cache.set({
      url: USER_URL,
      accept: "application/vnd.github+json",
      etag: 'W/"poisoned"',
      body: "<html>not json</html>",
      fetchedAt: iso(-HOUR_MS), // fresh by TTL, corrupt by content
    });
    const log: Recorded[] = [];
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(stageAHandler, log) });
    const result = await importer.listRepos("octocat");
    expect(result.repos.length).toBeGreaterThan(0); // served live, not a SyntaxError 500
    const userDial = log.find((r) => r.url === USER_URL);
    expect(userDial).toBeDefined();
    // No conditional replay either — a 304 would only re-serve the bad bytes.
    expect(headerOf(userDial!, "If-None-Match")).toBeUndefined();
  });

  it("a live 200 writes through to disk: the warm re-run dials nothing quota-bearing, and an aged record replays the captured etag (review C1)", async () => {
    // Offset clock: records are written with real timestamps, so the fake
    // clock must track real time until the test deliberately ages it.
    let offsetMs = 0;
    const clockedCache = new GithubEtagCache(dir, { now: () => Date.now() + offsetMs });
    const coldLog: Recorded[] = [];
    const cold = new RestGithubImporter({ cache: clockedCache, fetchImpl: fetchFake(stageAHandler, coldLog) });
    await cold.listRepos("octocat");
    expect(coldLog.map((r) => r.url)).toEqual([USER_URL, REPOS_URL]);

    // Warm: only the quota-free /rate_limit may dial — the 200 bodies must
    // come back from data written by the FIRST run (deleting the
    // write-through fails here).
    const warmLog: Recorded[] = [];
    const warmHandler = (url: string): Response => {
      if (url === RATE_URL) {
        return respond(url, { resources: { core: { limit: 60, remaining: 59, reset: 1750000000 } } });
      }
      throw new Error(`quota-bearing dial on a warm run: ${url}`);
    };
    const warm = new RestGithubImporter({ cache: clockedCache, fetchImpl: fetchFake(warmHandler, warmLog) });
    const result = await warm.listRepos("octocat");
    expect(result.repos.map((r) => r.name)).toEqual(["beta", "alpha"]);
    expect(warmLog.map((r) => r.url)).toEqual([RATE_URL]);

    // Age past the 24h TTL: the stale record must replay the etag the
    // FIRST run's 200 carried ('W/"list-v1"'), byte-exact.
    offsetMs = 25 * HOUR_MS;
    const agedLog: Recorded[] = [];
    const agedHandler = (url: string): Response => {
      if (url === REPOS_URL) return respond(url, null, { status: 304, headers: okRate });
      return stageAHandler(url);
    };
    const aged = new RestGithubImporter({ cache: clockedCache, fetchImpl: fetchFake(agedHandler, agedLog) });
    await aged.listRepos("octocat");
    const reposDial = agedLog.find((r) => r.url === REPOS_URL);
    expect(headerOf(reposDial!, "If-None-Match")).toBe('W/"list-v1"');
  });

  it("every dial is timeout-bounded and composes the caller's signal (review C5)", async () => {
    const hangUntilAborted: typeof fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal); // a dial without a signal would hang forever
        if (signal?.aborted) reject(new Error("aborted by signal"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
      })) as typeof fetch;

    // (a) the per-dial timeout fires on its own
    const timed = new RestGithubImporter({ cache, fetchImpl: hangUntilAborted, timeoutMs: 25 });
    const started = Date.now();
    const timeoutFailure = await timed.listRepos("octocat").catch((err: unknown) => err);
    expect(isGithubImportError(timeoutFailure) && timeoutFailure.code === "network").toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    // (b) the caller's signal aborts the dial without waiting for the timeout
    const slow = new RestGithubImporter({ cache, fetchImpl: hangUntilAborted, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = slow.listRepos("octocat", controller.signal).catch((err: unknown) => err);
    controller.abort();
    const abortFailure = await pending;
    expect(isGithubImportError(abortFailure) && abortFailure.code === "network").toBe(true);
  });

  it("a fresh cached /languages imports at remaining 0 — cache hits bypass the quota guard (review C7)", async () => {
    const accept = "application/vnd.github+json";
    await cache.set({
      url: langUrl("one"),
      accept,
      body: JSON.stringify({ Go: 10 }),
      fetchedAt: iso(-HOUR_MS),
    });
    const log: Recorded[] = [];
    const handler = (url: string): Response => {
      if (url === REPOS_URL) {
        return respond(url, [rawRepo("one")], {
          headers: { ...okRate, "x-ratelimit-remaining": "0" },
        });
      }
      throw new Error(`unexpected dial at remaining 0: ${url}`);
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, log) });
    const { entries, report } = await importer.importRepos("octocat", ["one"]);
    expect(entries.projects.map((p) => p.name)).toEqual(["one"]); // imported, not quota-skipped
    expect(report.notes).toEqual([]);
    expect(log.map((r) => r.url)).toEqual([REPOS_URL]); // zero /languages or /rate_limit dials
  });

  it("rejects a response whose FINAL url landed off api.github.com (decision 44)", async () => {
    const handler = (url: string): Response => {
      if (url === USER_URL) {
        // fetch followed a 30x: response.url is the redirect target.
        return respond("https://evil.example/users/octocat", { login: "octocat" }, { headers: okRate });
      }
      throw new Error(`unexpected dial ${url}`);
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, []) });
    const failure = await importer.listRepos("octocat").catch((err: unknown) => err);
    expect(isGithubImportError(failure) && failure.code === "off_host").toBe(true);
    // The off-host body was never used and never cached.
    await expect(readdir(dir).catch(() => [])).resolves.toEqual([]);
  });

  it("stage B is strictly serial — never two languages dials in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const handler = async (url: string): Promise<Response> => {
      if (url === REPOS_URL) return respond(url, [rawRepo("one"), rawRepo("two")], { headers: okRate });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return respond(url, { Go: 10 }, { headers: okRate });
    };
    const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, []) });
    await importer.importRepos("octocat", ["one", "two"]);
    expect(maxInFlight).toBe(1);
  });

  it("maps taxonomy: 404 -> not_found, 403 with remaining 0 -> rate_limited, bad input never dials", async () => {
    const notFound = new RestGithubImporter({
      cache,
      fetchImpl: fetchFake((url) => respond(url, { message: "Not Found" }, { status: 404 }), []),
    });
    const nf = await notFound.listRepos("octocat").catch((err: unknown) => err);
    expect(isGithubImportError(nf) && nf.code === "not_found").toBe(true);

    const limited = new RestGithubImporter({
      cache,
      fetchImpl: fetchFake(
        (url) =>
          respond(url, { message: "API rate limit exceeded" }, {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1750000000" },
          }),
        [],
      ),
    });
    const rl = await limited.listRepos("octocat").catch((err: unknown) => err);
    expect(isGithubImportError(rl) && rl.code === "rate_limited").toBe(true);

    const log: Recorded[] = [];
    const guarded = new RestGithubImporter({ cache, fetchImpl: fetchFake(stageAHandler, log) });
    const bad = await guarded.listRepos("../evil").catch((err: unknown) => err);
    expect(isGithubImportError(bad) && bad.code === "input_invalid").toBe(true);
    expect(log).toHaveLength(0); // charset schema fired BEFORE any URL was built
  });

  it("never leaks the token: response JSON, cache records, and console output scan clean (decision 56)", async () => {
    const token = "ghp_SUPERSECRET_LEAKCHECK";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const handler = (url: string, init: RequestInit | undefined): Response => {
        if (url === "https://api.github.com/graphql") {
          expect(init?.method).toBe("POST");
          return respond(url, { data: { user: { pinnedItems: { nodes: [] } } } });
        }
        if (url === langUrl("alpha")) return respond(url, { Rust: 42 }, { headers: okRate });
        if (url === RATE_URL) {
          return respond(url, { resources: { core: { limit: 5000, remaining: 4999, reset: 1750000000 } } });
        }
        return stageAHandler(url);
      };
      const importer = new RestGithubImporter({ cache, fetchImpl: fetchFake(handler, []), token });
      const listed = await importer.listRepos("octocat");
      const imported = await importer.importRepos("octocat", ["alpha"]);

      expect(JSON.stringify(listed)).not.toContain(token);
      expect(JSON.stringify(imported)).not.toContain(token);
      for (const file of await readdir(dir)) {
        expect(await readFile(path.join(dir, file), "utf8")).not.toContain(token);
      }
      const consoleText = [logSpy, warnSpy, errorSpy]
        .flatMap((spy) => spy.mock.calls.flat())
        .map(String)
        .join("\n");
      expect(consoleText).not.toContain(token);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("imported entries are verbatim + provenance-stamped (mapping through the real fold)", async () => {
    const handler = (url: string): Response => {
      if (url === REPOS_URL) return respond(url, [rawRepo("alpha")], { headers: okRate });
      if (url === langUrl("alpha")) return respond(url, { TypeScript: 90, CSS: 10 }, { headers: okRate });
      throw new Error(`unexpected dial ${url}`);
    };
    const importer = new RestGithubImporter({
      cache,
      fetchImpl: fetchFake(handler, []),
      mintId: () => "fixed-id",
      now: () => "2026-07-12T00:00:00.000Z",
    });
    const { entries } = await importer.importRepos("octocat", ["alpha"]);
    expect(entries.projects).toEqual([
      {
        id: "fixed-id",
        name: "alpha",
        url: "https://github.com/octocat/alpha",
        technologies: ["testing", "TypeScript", "CSS"],
        bullets: [],
        github: {
          fullName: "octocat/alpha",
          description: "The alpha repo",
          stars: 5,
          pushedAt: "2026-01-02T03:04:05Z",
          languages: { TypeScript: 90, CSS: 10 },
        },
        provenance: {
          origin: "github-api",
          ref: {
            url: "https://github.com/octocat/alpha",
            label: "octocat/alpha",
            fetchedAt: "2026-07-12T00:00:00.000Z",
          },
          importedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    ]);
  });
});

describe("GithubEtagCache", () => {
  let dir: string;
  let cache: GithubEtagCache;
  const accept = "application/vnd.github+json";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "clarity-etag-"));
    cache = new GithubEtagCache(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("misses on empty dir, round-trips fresh, ages to stale, treats future timestamps as corrupt", async () => {
    expect((await cache.get("https://api.github.com/x", accept)).kind).toBe("miss");

    await cache.set({ url: "https://api.github.com/x", accept, body: "{}", fetchedAt: iso(-HOUR_MS) });
    expect((await cache.get("https://api.github.com/x", accept)).kind).toBe("fresh");

    await cache.set({ url: "https://api.github.com/x", accept, body: "{}", fetchedAt: iso(-25 * HOUR_MS) });
    expect((await cache.get("https://api.github.com/x", accept)).kind).toBe("stale");

    await cache.set({ url: "https://api.github.com/x", accept, body: "{}", fetchedAt: iso(+HOUR_MS) });
    expect((await cache.get("https://api.github.com/x", accept)).kind).toBe("miss");
  });

  it("keys by url AND accept; corrupt bytes are a miss, never a throw", async () => {
    await cache.set({ url: "https://api.github.com/x", accept, body: "{}", fetchedAt: iso(0) });
    expect((await cache.get("https://api.github.com/x", "text/plain")).kind).toBe("miss");

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, files[0]!), "not json", "utf8");
    expect((await cache.get("https://api.github.com/x", accept)).kind).toBe("miss");
  });
});
