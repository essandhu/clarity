import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { cheerioStrip, normalizeWhitespace } from "./cheerioStrip";

// Gate 5 (PLAN.md decision 13): isProbablyReaderable routes between
// Readability (article-shaped pages) and the cheerio strip (everything else).
// Readability returns null on thin pages — the common case for careers pages
// — so the cheerio path is mandatory, not optional. window.close() in finally
// prevents jsdom window-graph leaks (risk 10). Readability.parse() mutates
// the document, which is fine: the JSDOM here is throwaway.

// Soft-404 heuristic (risk 4): below this many cleaned chars a page cannot
// ground a claim — an honest empty_content skip beats a false `found`.
export const MIN_TEXT_CHARS = 200;
const SOFT_404_TITLE = /404|not found/i;

export type CleanOutcome =
  | { kind: "cleaned"; title: string; text: string }
  | { kind: "thin"; detail: string };

export function readabilityClean(html: string, url: string): CleanOutcome {
  let title = "";
  let text = "";

  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;
    title = doc.title.trim();
    if (isProbablyReaderable(doc)) {
      let article: ReturnType<Readability["parse"]> = null;
      try {
        article = new Readability(doc).parse();
      } catch {
        article = null; // treat a Readability crash as "no article" and fall through
      }
      text = normalizeWhitespace(article?.textContent ?? "");
      if (!title) title = article?.title?.trim() ?? "";
    }
  } finally {
    dom.window.close();
  }

  // The cheerio path is mandatory, not optional (decision 13): Readability
  // returning null OR unusably little text both fall through — keeping
  // whichever extraction found more.
  if (text.length < MIN_TEXT_CHARS) {
    const stripped = cheerioStrip(html);
    if (!title) title = stripped.title;
    if (stripped.text.length > text.length) text = stripped.text;
  }

  if (SOFT_404_TITLE.test(title)) {
    return { kind: "thin", detail: `title looks like an error page: "${title}"` };
  }
  if (text.length < MIN_TEXT_CHARS) {
    return { kind: "thin", detail: `cleaned text too short to use (${text.length} chars)` };
  }
  return { kind: "cleaned", title, text };
}
