import type { CleanPage } from "@/shared/schema";
import { urlKey, type EnrichmentCandidate } from "./candidateUrls";

// Tier-2/3 discovery (decision 20): candidates are mined from REAL anchors on
// fetched Tier-1 pages — GitHub org, blog/engineering/changelog (tier 2),
// news/press (tier 3). Slug-guessing (github.com/{slug}, blog.{domain}) is a
// FALLBACK used only when discovery found nothing, and a guessed page may
// count as found only when it loosely matches the company name — that rule is
// what largely eliminates the wrong-org fabrication risk.

export const TIER2_MAX = 3;
export const TIER3_MAX = 2;

// Social profiles are neither blog nor news, however their anchors are
// labeled. (LinkedIn is contact-surfacing territory, increment 8 — not here.)
const SOCIAL_HOSTS = [
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "linkedin.com",
];

// First path segments under github.com that are product pages, never orgs.
const GITHUB_RESERVED = new Set([
  "about", "apps", "blog", "collections", "contact", "customer-stories",
  "enterprise", "events", "explore", "features", "join", "login",
  "marketplace", "mobile", "new", "notifications", "pricing", "readme",
  "resources", "search", "security", "settings", "signup", "site",
  "solutions", "sponsors", "team", "topics", "trending",
]);
const GITHUB_OWNER_SHAPE = /^[a-zA-Z0-9-]+$/;

const CHANGELOG_URL = /changelog|release-?notes|\/releases(\/|$)|\/whats-new(\/|$)/i;
const CHANGELOG_TEXT = /\b(changelog|release notes|what'?s new)\b/i;
const BLOG_URL = /^https?:\/\/(blog|engineering)\.|\/(blog|engineering|eng-blog|writing)(\/|$)|\.substack\.com|\bmedium\.com|\bdev\.to/i;
const BLOG_TEXT = /\b(blog|engineering|writing)\b/i;
const NEWS_URL = /\/(news|newsroom|press|announcements|launches?|media\/press)(\/|$)/i;
const NEWS_TEXT = /\b(news|newsroom|press|announcements?|launches?|in the media)\b/i;

export interface DiscoveredCandidates {
  tier2: EnrichmentCandidate[];
  tier3: EnrichmentCandidate[];
}

export function discoverCandidates(
  pages: CleanPage[],
  opts: { exclude: ReadonlySet<string> },
): DiscoveredCandidates {
  const seen = new Set(opts.exclude);
  const github: EnrichmentCandidate[] = [];
  const blogish: EnrichmentCandidate[] = [];
  const news: EnrichmentCandidate[] = [];

  const claim = (url: string): boolean => {
    const key = urlKey(url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const page of pages) {
    for (const link of page.links ?? []) {
      let parsed: URL;
      try {
        parsed = new URL(link.url);
      } catch {
        continue;
      }
      if (!isPublicHttpHost(parsed.hostname)) continue;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) {
        continue;
      }
      if (host === "github.com") {
        // github.com links are ONLY ever org candidates — github.com/blog is
        // GitHub's own blog, not the company's.
        const org = githubOrgUrl(parsed);
        if (org && claim(org)) {
          github.push({ url: org, tier: 2, label: "Reading GitHub org…" });
        }
        continue;
      }
      if (CHANGELOG_URL.test(link.url) || CHANGELOG_TEXT.test(link.text)) {
        if (claim(link.url)) blogish.push({ url: link.url, tier: 2, label: "Reading changelog…" });
      } else if (BLOG_URL.test(link.url) || BLOG_TEXT.test(link.text)) {
        if (claim(link.url)) blogish.push({ url: link.url, tier: 2, label: "Reading blog…" });
      } else if (NEWS_URL.test(link.url) || NEWS_TEXT.test(link.text)) {
        if (claim(link.url)) news.push({ url: link.url, tier: 3, label: "Reading news page…" });
      }
    }
  }

  // One GitHub org is plenty; the remaining tier-2 slots go to blog/changelog.
  return {
    tier2: [...github.slice(0, 1), ...blogish].slice(0, TIER2_MAX),
    tier3: news.slice(0, TIER3_MAX),
  };
}

// Discovered anchors are attacker-influenced — any fetched page can carry
// them. Never let one steer the server-side fetcher at loopback, IP-literal,
// or intranet-style hosts (increment-6 review finding).
const PRIVATE_TLDS = new Set([
  "corp", "home", "internal", "intranet", "invalid", "lan", "local",
  "localdomain", "localhost", "test",
]);

function isPublicHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":") || /^[0-9.]+$/.test(host)) return false; // IP literals
  const labels = host.split(".");
  if (labels.length < 2) return false; // single-label intranet names
  if (PRIVATE_TLDS.has(labels[labels.length - 1])) return false;
  if (host.endsWith(".home.arpa")) return false;
  return true;
}

/** Normalize any github.com link (repo, orgs/ page, …) to its owner page —
 *  the org page is where the loose name check and increment-8's org-page-only
 *  contact scope both operate. */
function githubOrgUrl(parsed: URL): string | undefined {
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0]?.toLowerCase() === "orgs" ? segments[1] : segments[0];
  if (!owner || GITHUB_RESERVED.has(owner.toLowerCase()) || !GITHUB_OWNER_SHAPE.test(owner)) {
    return undefined;
  }
  return `https://github.com/${owner}`;
}

/** Fallback tier-2 guesses, used ONLY when discovery found nothing. Both
 *  require the fetched page to loosely match the company name. */
export function slugGuessCandidates(domain: string | undefined): EnrichmentCandidate[] {
  if (!domain) return [];
  const slug = domain.split(".")[0];
  const guesses: EnrichmentCandidate[] = [];
  if (slug && GITHUB_OWNER_SHAPE.test(slug)) {
    guesses.push({
      url: `https://github.com/${slug}`,
      tier: 2,
      label: "Checking guessed GitHub org…",
      requiresNameMatch: true,
    });
  }
  guesses.push({
    url: `https://blog.${domain}`,
    tier: 2,
    label: "Checking guessed blog…",
    requiresNameMatch: true,
  });
  return guesses;
}

// Trailing legal-form tokens that may be dropped from a company name when
// matching ("Tessellate, Inc." should match a page that says "Tessellate").
const LEGAL_SUFFIXES = new Set([
  "ab", "ag", "bv", "co", "company", "corp", "corporation", "gmbh", "inc",
  "incorporated", "limited", "llc", "ltd", "oy", "plc", "sas",
]);

/**
 * The decision-20 loose name match: does the fetched page plausibly belong to
 * this company? Case- and punctuation-insensitive; checks the title plus the
 * head of the text (guessed pages that never mention the company anywhere up
 * front are exactly the wrong-org risk this exists to catch).
 */
export function looseNameMatch(
  company: string,
  page: { title: string; text: string },
): boolean {
  const name = normalizeForMatch(company);
  if (!name) return false;
  const tokens = name.split(" ");
  const candidates = new Set([name]);
  if (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    candidates.add(tokens.slice(0, -1).join(" "));
  }
  const haystack = ` ${normalizeForMatch(stripUrlEchoes(`${page.title} ${page.text.slice(0, 2_000)}`))} `;
  return [...candidates].some((candidate) => haystack.includes(` ${candidate} `));
}

/**
 * A parked/squatted page always echoes the hostname it was reached at
 * ("blog.acme.dev is for sale"), which would satisfy the match for exactly
 * the guesses the rule is supposed to police — so full URLs and
 * hostname-shaped tokens are deleted before matching (increment-6 review
 * finding). Known residual, accepted per risk 4: a github.com/{slug} page
 * titles itself "{slug} · GitHub", so a single-token company name equal to
 * the domain label still passes on a stranger's org.
 */
function stripUrlEchoes(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, " ");
}

function normalizeForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
