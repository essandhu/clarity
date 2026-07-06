import { describe, expect, it } from "vitest";
import { isPublicHttpHost, tier1Candidates, urlKey } from "./candidateUrls";

describe("tier1Candidates", () => {
  it("derives the homepage plus the four §4 paths, all tier 1, one host", () => {
    const candidates = tier1Candidates("acme.dev");
    expect(candidates.map((c) => c.url)).toEqual([
      "https://acme.dev/",
      "https://acme.dev/about",
      "https://acme.dev/careers",
      "https://acme.dev/jobs",
      "https://acme.dev/product",
    ]);
    expect(candidates).toHaveLength(5);
    for (const candidate of candidates) {
      expect(candidate.tier).toBe(1);
      expect(candidate.label).toMatch(/^Reading .+…$/);
      expect(candidate.requiresNameMatch).toBeUndefined();
    }
  });

  it("returns [] without a domain — and for junk that cannot form a URL", () => {
    expect(tier1Candidates(undefined)).toEqual([]);
    expect(tier1Candidates("not a host")).toEqual([]);
  });

  it("refuses private/internal hosts — the SSRF guard (review finding A)", () => {
    for (const host of ["it.corp", "wiki.internal", "db.local", "app.localhost", "127.0.0.1"]) {
      expect(tier1Candidates(host)).toEqual([]);
    }
  });
});

describe("isPublicHttpHost", () => {
  it("accepts ordinary public hosts", () => {
    for (const host of ["acme.dev", "www.acme.dev", "boards.greenhouse.io", "a.b.co.uk"]) {
      expect(isPublicHttpHost(host)).toBe(true);
    }
  });

  it("rejects loopback, IP literals, single-label and private-TLD hosts", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "169.254.169.254",
      "2130706433",
      "[::1]",
      "intranet",
      "wiki.internal",
      "svc.lan",
      "db.local",
      "printer.corp",
      "host.home.arpa",
    ]) {
      expect(isPublicHttpHost(host)).toBe(false);
    }
  });
});

describe("urlKey", () => {
  it("treats fragment and trailing-slash variants as the same candidate", () => {
    expect(urlKey("https://acme.dev/about/")).toBe(urlKey("https://acme.dev/about"));
    expect(urlKey("https://acme.dev/news#latest")).toBe(urlKey("https://acme.dev/news"));
  });

  it("keeps query strings significant and the root path intact", () => {
    expect(urlKey("https://acme.dev/news?p=1")).not.toBe(urlKey("https://acme.dev/news?p=2"));
    expect(urlKey("https://acme.dev/")).toBe("https://acme.dev/");
  });
});
