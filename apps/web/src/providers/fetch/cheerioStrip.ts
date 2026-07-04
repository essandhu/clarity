import { load } from "cheerio";

// Fallback text strip for pages Readability can't handle — thin/non-article
// markup is the COMMON case for sparse careers pages (PLAN.md decision 13).
// cheerio's .text() is textContent, not visible text: it would include
// <script>/<style> bodies, so those are removed first. $("body") (never
// $.root()) keeps <head>/<title> text out of the page text. header/footer/
// aside are deliberately KEPT — small-company pages put contact lines there.

export function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Block-level boundaries become newlines before .text() — otherwise adjacent
// cells/items jam into nonsense words ("143 jobsEngineeringAI Engineering")
// and degrade every downstream model extraction.
const BLOCK_ELEMENTS =
  "p, div, li, ul, ol, table, tr, td, th, h1, h2, h3, h4, h5, h6, section, article, header, footer, main, aside, blockquote, dt, dd, figcaption";

export function cheerioStrip(html: string): { title: string; text: string } {
  const $ = load(html);
  const title = $("title").first().text().trim();
  $("script, style, noscript, template, svg, iframe, canvas, nav").remove();
  $("br").replaceWith("\n");
  $(BLOCK_ELEMENTS).after("\n");
  return { title, text: normalizeWhitespace($("body").text()) };
}
