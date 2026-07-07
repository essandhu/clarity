import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "@/domain/pipeline/clock";
import type { CleanPage } from "@/shared/schema";
import { JsonFilePageCache, PAGE_CACHE_TTL_MS } from "./JsonFilePageCache";

// Real fs against a per-test temp dir (this provider IS the fs edge — a
// mocked fs would test the mock), fake clock for TTL (decision 22 precedent).

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clarity-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clockAt = (now: number): Clock => ({ now: () => now });

const T0 = Date.parse("2026-07-06T10:00:00.000Z");

function page(overrides: Partial<CleanPage> = {}): CleanPage {
  return {
    kind: "page",
    url: "https://acme.dev/careers",
    finalUrl: "https://acme.dev/careers",
    title: "Acme Careers",
    text: "We build collaboration tools for regulated teams.",
    fetchedAt: new Date(T0).toISOString(),
    links: [{ url: "https://github.com/acme", text: "GitHub" }],
    ...overrides,
  };
}

const keyFile = (url: string) =>
  path.join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);

describe("JsonFilePageCache — round trip", () => {
  it("set → get returns the page byte-faithfully, links included", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0 + 1_000));
    await cache.set(page());
    // Tier-2/3 discovery mines links from cached tier-1 pages on re-runs —
    // a cache that dropped them would silently kill discovery (decision 20).
    expect(await cache.get("https://acme.dev/careers")).toEqual(page());
  });

  it("keys files by sha256(url) under the injected dir, created lazily", async () => {
    const cache = new JsonFilePageCache(path.join(dir, "pages"), clockAt(T0));
    await cache.set(page());
    const files = await readdir(path.join(dir, "pages"));
    expect(files).toEqual([
      `${createHash("sha256").update("https://acme.dev/careers").digest("hex")}.json`,
    ]);
  });

  it("a redirect-renamed page is retrievable under BOTH the requested and final url", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    const redirected = page({ finalUrl: "https://acme.dev/careers/" });
    await cache.set(redirected);
    // Enrichment re-runs key by the candidate (requested) url; contact
    // re-reads key by the SourceRef they hold, which carries the FINAL url.
    expect(await cache.get("https://acme.dev/careers")).toEqual(redirected);
    expect(await cache.get("https://acme.dev/careers/")).toEqual(redirected);
  });

  it("a later set for the same url overwrites the entry", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0 + 5_000));
    await cache.set(page({ text: "old text" }));
    await cache.set(page({ text: "new text", fetchedAt: new Date(T0 + 4_000).toISOString() }));
    expect((await cache.get("https://acme.dev/careers"))?.text).toBe("new text");
  });
});

describe("JsonFilePageCache — every degraded state is a miss, never a throw", () => {
  it("missing entry → null (what a mid-run file deletion degrades to)", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    expect(await cache.get("https://acme.dev/never-stored")).toBeNull();
  });

  it("non-JSON bytes → null", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    await writeFile(keyFile("https://acme.dev/careers"), "{ torn wri", "utf8");
    expect(await cache.get("https://acme.dev/careers")).toBeNull();
  });

  it("valid JSON that is not a CleanPage → null (schema drift = corrupt)", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    await writeFile(
      keyFile("https://acme.dev/careers"),
      JSON.stringify({ kind: "page", url: "https://acme.dev/careers", text: 42 }),
      "utf8",
    );
    expect(await cache.get("https://acme.dev/careers")).toBeNull();
  });

  it("get never throws on a directory that does not exist", async () => {
    const cache = new JsonFilePageCache(path.join(dir, "never-created"), clockAt(T0));
    expect(await cache.get("https://acme.dev/careers")).toBeNull();
  });

  it("set never throws when the dir path is unusable (a file sits where the dir should)", async () => {
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "i am a file", "utf8");
    const cache = new JsonFilePageCache(blocked, clockAt(T0));
    await expect(cache.set(page())).resolves.toBeUndefined();
  });

  it("the pasted-listing sentinel is just another missing key, never an error", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    expect(await cache.get("listing:pasted")).toBeNull();
  });
});

describe("JsonFilePageCache — 24h TTL off fetchedAt", () => {
  it("an entry one tick under 24h old is fresh; at exactly 24h it is stale", async () => {
    await new JsonFilePageCache(dir, clockAt(T0)).set(page());
    const fresh = new JsonFilePageCache(dir, clockAt(T0 + PAGE_CACHE_TTL_MS - 1));
    expect(await fresh.get("https://acme.dev/careers")).not.toBeNull();
    const stale = new JsonFilePageCache(dir, clockAt(T0 + PAGE_CACHE_TTL_MS));
    expect(await stale.get("https://acme.dev/careers")).toBeNull();
  });

  it("an entry fetched in the FUTURE is a miss, not an immortal hit", async () => {
    await new JsonFilePageCache(dir, clockAt(T0)).set(
      page({ fetchedAt: "9999-01-01T00:00:00.000Z" }),
    );
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    expect(await cache.get("https://acme.dev/careers")).toBeNull();
  });

  it("a stale entry is refreshed by the next set (TTL never wedges a key)", async () => {
    await new JsonFilePageCache(dir, clockAt(T0)).set(page());
    const later = T0 + PAGE_CACHE_TTL_MS + 60_000;
    const cache = new JsonFilePageCache(dir, clockAt(later));
    expect(await cache.get("https://acme.dev/careers")).toBeNull();
    await cache.set(page({ fetchedAt: new Date(later).toISOString() }));
    expect(await cache.get("https://acme.dev/careers")).not.toBeNull();
  });
});

describe("JsonFilePageCache — payload hygiene", () => {
  it("stores exactly the CleanPage JSON (inspectable, greppable flat file)", async () => {
    const cache = new JsonFilePageCache(dir, clockAt(T0));
    await cache.set(page());
    const raw = await readFile(keyFile("https://acme.dev/careers"), "utf8");
    expect(JSON.parse(raw)).toEqual(page());
  });
});
