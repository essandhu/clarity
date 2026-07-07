import { describe, expect, it } from "vitest";
import type { BudgetToken } from "@/domain/pipeline/RunBudget";
import type { PageCache } from "@/providers/cache/PageCache";
import { CleanPageSchema, FetchSkipSchema, type CleanPage } from "@/shared/schema";
import { RobotsAwarePageFetcher } from "./RobotsAwarePageFetcher";

// Gate 0 (increment 9): the cache sits before robots, limiter, policy and
// network — a hit must produce ZERO dispatches (not even robots.txt), and a
// broken cache must degrade to a plain fetch, never a failed one.

const token = (): BudgetToken => ({ timeoutMs: 5_000, signal: new AbortController().signal });

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const PAGE_HTML = `<html><head><title>Acme Careers</title></head><body><main>
  ${"We build collaboration tools for regulated teams. ".repeat(12)}
  <a href="https://github.com/acme">GitHub</a>
</main></body></html>`;

function stubFetch() {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    return new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS });
  }) as typeof fetch;
  return { impl, calls };
}

class InMemoryPageCache implements PageCache {
  readonly store = new Map<string, CleanPage>();
  readonly gets: string[] = [];
  async get(url: string): Promise<CleanPage | null> {
    this.gets.push(url);
    return this.store.get(url) ?? null;
  }
  async set(page: CleanPage): Promise<void> {
    this.store.set(page.url, page);
  }
}

const warmPage = (url: string): CleanPage => ({
  kind: "page",
  url,
  finalUrl: url,
  title: "Acme Careers (cached)",
  text: "Cached body text about regulated teams.",
  fetchedAt: "2026-07-06T09:00:00.000Z",
  links: [{ url: "https://github.com/acme", text: "GitHub" }],
});

describe("RobotsAwarePageFetcher — cache gate 0", () => {
  it("a warm entry is served with zero network dispatches (not even robots.txt)", async () => {
    const url = "https://c-hit.test/careers";
    const cache = new InMemoryPageCache();
    cache.store.set(url, warmPage(url));
    const { impl, calls } = stubFetch();
    const result = await new RobotsAwarePageFetcher(impl, cache).fetchClean(url, token());
    expect(CleanPageSchema.parse(result)).toEqual(warmPage(url));
    expect(calls).toHaveLength(0);
  });

  it("a miss fetches, then writes the cleaned page through — links included", async () => {
    const url = "https://c-miss.test/careers";
    const cache = new InMemoryPageCache();
    const { impl } = stubFetch();
    const result = await new RobotsAwarePageFetcher(impl, cache).fetchClean(url, token());
    const page = CleanPageSchema.parse(result);
    expect(cache.store.get(url)).toEqual(page);
    expect(cache.store.get(url)?.links).toContainEqual({
      url: "https://github.com/acme",
      text: "GitHub",
    });
  });

  it("skips are never cached — a 404 today must retry tomorrow", async () => {
    const url = "https://c-skip.test/careers";
    const cache = new InMemoryPageCache();
    const impl = (async () =>
      new Response("gone", { status: 404, headers: HTML_HEADERS })) as typeof fetch;
    const skip = await new RobotsAwarePageFetcher(impl, cache).fetchClean(url, token());
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "http_status" });
    expect(cache.store.size).toBe(0);
  });

  it("cached() peeks the cache without touching budget or network", async () => {
    const url = "https://c-peek.test/careers";
    const cache = new InMemoryPageCache();
    cache.store.set(url, warmPage(url));
    const { impl, calls } = stubFetch();
    const fetcher = new RobotsAwarePageFetcher(impl, cache);
    expect(await fetcher.cached(url)).toEqual(warmPage(url));
    expect(await fetcher.cached("https://c-peek.test/other")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a cacheless fetcher peeks null and fetches normally", async () => {
    const { impl } = stubFetch();
    const fetcher = new RobotsAwarePageFetcher(impl);
    expect(await fetcher.cached("https://c-none.test/careers")).toBeNull();
    const result = await fetcher.fetchClean("https://c-none.test/careers", token());
    expect(CleanPageSchema.parse(result).kind).toBe("page");
  });

  it("a cache whose get() throws degrades to a plain fetch", async () => {
    const cache: PageCache = {
      get: async () => {
        throw new Error("disk exploded");
      },
      set: async () => {},
    };
    const { impl } = stubFetch();
    const result = await new RobotsAwarePageFetcher(impl, cache).fetchClean(
      "https://c-getthrow.test/careers",
      token(),
    );
    expect(CleanPageSchema.parse(result).kind).toBe("page");
  });

  it("a cache whose set() throws never turns a successful fetch into a failure", async () => {
    const cache: PageCache = {
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const { impl } = stubFetch();
    const result = await new RobotsAwarePageFetcher(impl, cache).fetchClean(
      "https://c-setthrow.test/careers",
      token(),
    );
    expect(CleanPageSchema.parse(result).kind).toBe("page");
  });
});
