import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { systemClock, type Clock } from "@/domain/pipeline/clock";
import { CleanPageSchema, type CleanPage } from "@/shared/schema";
import type { PageCache } from "./PageCache";

// Flat-JSON page cache (PLAN.md decision 14): data/cache/pages/{sha256(url)}
// .json, no native modules. Every degraded state — missing file, unreadable
// file, torn write, schema drift, stale entry — is a MISS, never an error:
// the fetcher behind this simply refetches. The directory is created lazily
// on first write (§2 tree: "pages/ created lazily").

export const PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class JsonFilePageCache implements PageCache {
  constructor(
    private readonly dir: string,
    // Injected for TTL tests (the RunBudget fake-clock precedent); production
    // uses the system clock.
    private readonly clock: Clock = systemClock,
  ) {}

  async get(url: string): Promise<CleanPage | null> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(url), "utf8");
    } catch {
      return null; // missing or unreadable = miss
    }
    let page: CleanPage;
    try {
      page = CleanPageSchema.parse(JSON.parse(raw));
    } catch {
      return null; // corrupt (torn write, schema drift) = miss
    }
    // fetchedAt parses — the schema pinned it as an ISO datetime. An entry
    // from the FUTURE is treated as corrupt rather than immortal: get() would
    // otherwise serve it forever, since only a fetch (which a permanent hit
    // prevents) ever overwrites it.
    const age = this.clock.now() - Date.parse(page.fetchedAt);
    if (!(age >= 0 && age < PAGE_CACHE_TTL_MS)) return null;
    return page;
  }

  async set(page: CleanPage): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const payload = JSON.stringify(page);
      await writeFile(this.fileFor(page.url), payload, "utf8");
      // Contact re-reads look pages up by the SourceRef they hold, which
      // carries the FINAL url (pageSourceRef), while fetches are keyed by the
      // REQUESTED url — so a page whose redirect changed the URL (trailing
      // slash, http→https, cross-host) is stored under both keys.
      if (page.finalUrl !== page.url) {
        await writeFile(this.fileFor(page.finalUrl), payload, "utf8");
      }
    } catch {
      // Best-effort: a full disk or a permissions problem must never fail
      // the fetch that produced this page.
    }
  }

  private fileFor(url: string): string {
    return path.join(this.dir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }
}
