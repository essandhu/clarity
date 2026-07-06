import { load } from "cheerio";
import type { PageLink } from "@/shared/schema";

// Anchor capture for tier-2/3 link discovery (decision 20). Runs over the RAW
// html — Readability and the cheerio strip both discard hrefs — and hands the
// domain layer a bounded list of absolute http(s) links. Bounded on purpose:
// a fetched page is attacker-controlled and can carry thousands of anchors.

export const MAX_LINKS = 300;
export const MAX_LINK_TEXT_CHARS = 120;
// Discovered candidate URLs reach the wire as step.started.url / skip.url —
// one hostile mega-href must not become a multi-megabyte frame. Over-long
// links are dropped, not truncated (a truncated URL is a different resource).
export const MAX_LINK_URL_CHARS = 2_048;

export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const $ = load(html);
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const el of $("a[href]").toArray()) {
    if (links.length >= MAX_LINKS) break;
    const href = $(el).attr("href");
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    // mailto:, javascript:, tel: … resolve fine but are not fetchable; the
    // fetcher would reject them anyway — keep them out of discovery entirely.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    resolved.hash = ""; // fragment-only variants are the same document
    const url = resolved.toString();
    if (url.length > MAX_LINK_URL_CHARS) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      text: $(el).text().replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT_CHARS),
    });
  }
  return links;
}
