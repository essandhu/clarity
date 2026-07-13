import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "@/domain/pipeline/clock";

// Flat-JSON GitHub response cache (PLAN-RESUME.md §4.6, the JsonFilePageCache
// pattern): data/github/{sha256(url + '\n' + accept)}.json — ETags vary by
// Accept, so the accept header is part of the key. Every degraded state
// (missing, unreadable, torn write, schema drift, future timestamp) is a
// MISS, never an error. Keyless, a 304 still costs quota (live-verified per
// the brief), so a fresh-enough entry (24 h, the decision-14 number) is
// served WITHOUT dialing at all; a stale entry contributes its etag for a
// byte-exact If-None-Match replay (weak `W/` prefix preserved).
//
// The record stores response data ONLY — never request headers, so a
// configured GITHUB_TOKEN can never reach disk (decision 56).

export const GITHUB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const GithubCacheRecordSchema = z.object({
  url: z.string(),
  accept: z.string(),
  etag: z.string().optional(),
  body: z.string(),
  fetchedAt: z.iso.datetime(),
});
export type GithubCacheRecord = z.infer<typeof GithubCacheRecordSchema>;

export type GithubCacheLookup =
  | { kind: "fresh"; record: GithubCacheRecord }
  | { kind: "stale"; record: GithubCacheRecord }
  | { kind: "miss" };

export class GithubEtagCache {
  constructor(
    private readonly dir: string,
    // Injected for TTL tests (the JsonFilePageCache precedent).
    private readonly clock: Clock = systemClock,
  ) {}

  async get(url: string, accept: string): Promise<GithubCacheLookup> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(url, accept), "utf8");
    } catch {
      return { kind: "miss" }; // missing or unreadable
    }
    let record: GithubCacheRecord;
    try {
      record = GithubCacheRecordSchema.parse(JSON.parse(raw));
    } catch {
      return { kind: "miss" }; // corrupt (torn write, schema drift)
    }
    if (record.url !== url || record.accept !== accept) return { kind: "miss" };
    // A FUTURE fetchedAt is corrupt, not immortal (the page-cache lesson).
    const age = this.clock.now() - Date.parse(record.fetchedAt);
    if (!(age >= 0)) return { kind: "miss" };
    return age < GITHUB_CACHE_TTL_MS ? { kind: "fresh", record } : { kind: "stale", record };
  }

  async set(record: GithubCacheRecord): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.fileFor(record.url, record.accept), JSON.stringify(record), "utf8");
    } catch {
      // Best-effort: a full disk must never fail the fetch that produced
      // this response.
    }
  }

  private fileFor(url: string, accept: string): string {
    const digest = createHash("sha256").update(`${url}\n${accept}`).digest("hex");
    return path.join(this.dir, `${digest}.json`);
  }
}
