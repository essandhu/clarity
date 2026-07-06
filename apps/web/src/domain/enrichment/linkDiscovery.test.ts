import { describe, expect, it } from "vitest";
import type { CleanPage, PageLink } from "@/shared/schema";
import { urlKey } from "./candidateUrls";
import {
  discoverCandidates,
  looseNameMatch,
  slugGuessCandidates,
  TIER2_MAX,
  TIER3_MAX,
} from "./linkDiscovery";

const page = (links: PageLink[]): CleanPage => ({
  kind: "page",
  url: "https://acme.dev/",
  finalUrl: "https://acme.dev/",
  title: "Acme",
  text: "Acme builds robots.",
  fetchedAt: "2026-07-05T12:00:00.000Z",
  links,
});

const link = (url: string, text = ""): PageLink => ({ url, text });

const discover = (links: PageLink[], exclude: string[] = []) =>
  discoverCandidates([page(links)], { exclude: new Set(exclude.map(urlKey)) });

describe("discoverCandidates — tier 2", () => {
  it("normalizes github repo and orgs/ links to the owner page", () => {
    for (const href of [
      "https://github.com/acme-io/widget",
      "https://www.github.com/orgs/acme-io/repositories",
      "https://github.com/acme-io",
    ]) {
      const { tier2 } = discover([link(href, "GitHub")]);
      expect(tier2).toEqual([
        { url: "https://github.com/acme-io", tier: 2, label: "Reading GitHub org…" },
      ]);
    }
  });

  it("never treats github product pages as orgs", () => {
    const { tier2 } = discover([
      link("https://github.com/pricing", "Pricing"),
      link("https://github.com/features/actions", "Actions"),
      link("https://github.com/blog", "GitHub blog"),
    ]);
    expect(tier2).toEqual([]);
  });

  it("classifies blog links by URL shape or anchor text, changelog ahead of blog", () => {
    const { tier2 } = discover([
      link("https://acme.dev/changelog", "Changelog"),
      link("https://blog.acme.dev/", ""),
      link("https://medium.com/acme-eng", "Engineering"),
    ]);
    expect(tier2.map((c) => c.label)).toEqual([
      "Reading changelog…",
      "Reading blog…",
      "Reading blog…",
    ]);
  });

  it("keeps at most one github org and caps tier 2 overall", () => {
    const { tier2 } = discover([
      link("https://github.com/acme-io", "GitHub"),
      link("https://github.com/acme-labs", "GitHub too"),
      link("https://blog.acme.dev/", "Blog"),
      link("https://acme.dev/changelog", "Changelog"),
      link("https://acme.dev/engineering", "Engineering"),
    ]);
    expect(tier2).toHaveLength(TIER2_MAX);
    expect(tier2.filter((c) => c.url.startsWith("https://github.com/"))).toHaveLength(1);
  });
});

describe("discoverCandidates — tier 3 and exclusions", () => {
  it("classifies news/press links into tier 3, capped", () => {
    const { tier3 } = discover([
      link("https://acme.dev/news"),
      link("https://acme.dev/press", "Press"),
      link("https://acme.dev/newsroom", "Newsroom"),
    ]);
    expect(tier3).toHaveLength(TIER3_MAX);
    expect(tier3.every((c) => c.tier === 3 && c.label === "Reading news page…")).toBe(true);
  });

  it("ignores social hosts however the anchor is labeled", () => {
    const { tier2, tier3 } = discover([
      link("https://x.com/acme", "News"),
      link("https://www.linkedin.com/company/acme", "Blog"),
      link("https://youtube.com/@acme", "Engineering"),
    ]);
    expect(tier2).toEqual([]);
    expect(tier3).toEqual([]);
  });

  it("honors the exclude set and dedups across pages (slash/fragment variants too)", () => {
    const result = discoverCandidates(
      [
        page([link("https://acme.dev/blog", "Blog"), link("https://acme.dev/news", "News")]),
        page([link("https://acme.dev/blog/", "Blog"), link("https://acme.dev/news#x", "News")]),
      ],
      { exclude: new Set([urlKey("https://acme.dev/news")]) },
    );
    expect(result.tier2).toEqual([
      { url: "https://acme.dev/blog", tier: 2, label: "Reading blog…" },
    ]);
    expect(result.tier3).toEqual([]);
  });

  it("ignores pages without captured links", () => {
    const bare: CleanPage = { ...page([]), links: undefined };
    expect(discoverCandidates([bare], { exclude: new Set() })).toEqual({ tier2: [], tier3: [] });
  });
});

describe("slugGuessCandidates — the decision-20 fallback", () => {
  it("guesses the github slug and blog subdomain, both requiring a name match", () => {
    expect(slugGuessCandidates("tessellate.dev")).toEqual([
      {
        url: "https://github.com/tessellate",
        tier: 2,
        label: "Checking guessed GitHub org…",
        requiresNameMatch: true,
      },
      {
        url: "https://blog.tessellate.dev",
        tier: 2,
        label: "Checking guessed blog…",
        requiresNameMatch: true,
      },
    ]);
  });

  it("returns [] without a domain", () => {
    expect(slugGuessCandidates(undefined)).toEqual([]);
  });

  it("refuses to guess against private/internal domains (SSRF guard, review finding A)", () => {
    for (const host of ["it.corp", "db.local", "app.localhost"]) {
      expect(slugGuessCandidates(host)).toEqual([]);
    }
  });
});

describe("looseNameMatch", () => {
  const doc = (title: string, text: string) => ({ title, text });

  it("matches case- and punctuation-insensitively in title or text head", () => {
    expect(looseNameMatch("Acme Robotics", doc("ACME ROBOTICS — home", ""))).toBe(true);
    expect(looseNameMatch("Acme Robotics", doc("", "Welcome to Acme-Robotics, the leader…"))).toBe(
      true,
    );
  });

  it("drops a trailing legal suffix ('Tessellate, Inc.' matches 'Tessellate')", () => {
    expect(looseNameMatch("Tessellate, Inc.", doc("Tessellate · GitHub", ""))).toBe(true);
  });

  it("requires whole-word matches and rejects unrelated pages", () => {
    expect(looseNameMatch("Box", doc("Toolbox company", "toolbox tools"))).toBe(false);
    expect(looseNameMatch("Acme", doc("Globex Corporation", "Globex builds things"))).toBe(false);
  });

  it("only searches the head of the text — a mention buried at 10k chars is the wrong-org smell", () => {
    const buried = `${"x ".repeat(5_000)}Acme`;
    expect(looseNameMatch("Acme", doc("Unrelated", buried))).toBe(false);
  });

  it("never matches an empty or punctuation-only name", () => {
    expect(looseNameMatch("", doc("Anything", "anything"))).toBe(false);
    expect(looseNameMatch("···", doc("Anything", "anything"))).toBe(false);
  });

  it("a hostname echo alone never satisfies the match — parked pages always echo the domain", () => {
    expect(
      looseNameMatch(
        "Acme",
        doc(
          "blog.acme.dev — this domain is for sale",
          "Buy blog.acme.dev today! Premium domains like acme.dev sell fast.",
        ),
      ),
    ).toBe(false);
    // …while a real page mentioning the plain name still matches.
    expect(
      looseNameMatch("Acme", doc("Acme Engineering", "Notes from the team at acme.dev")),
    ).toBe(true);
  });
});

describe("discoverCandidates — private-host steering (review finding)", () => {
  it("never lets a discovered anchor steer the fetcher at private or intranet hosts", () => {
    const { tier2, tier3 } = discover([
      link("http://192.168.1.1/blog", "Blog"),
      link("http://localhost:8080/news", "News"),
      link("http://router.local/changelog", "Changelog"),
      link("http://intranet/news", "News"),
      link("https://[::1]/blog", "Blog"),
      link("http://printer.corp/press", "Press"),
    ]);
    expect(tier2).toEqual([]);
    expect(tier3).toEqual([]);
  });
});
