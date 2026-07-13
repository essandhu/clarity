// Count the pages in a compiled PDF by scanning for `/Type /Page` objects
// (PLAN-RESUME.md decision 52, §7.15). Zero deps — no pdf.js. `/Type /Pages`
// (the page-tree ROOT) must NOT count, so the match is anchored past `Page` to
// reject any trailing letter/digit ("Pages", "PageLabels"). Whitespace between
// `/Type` and `/Page` is optional and may be a newline.
//
// A count of 0 means the page objects live inside a compressed object stream
// (Tectonic's default) — the caller renders NOTHING in that case rather than a
// false "runs to 0 pages" claim; only a count > 1 surfaces the overflow note.

const PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z0-9])/g;

export function pdfPageCount(bytes: Uint8Array): number {
  // latin1 preserves every byte as a code unit, so binary stream data between
  // dictionaries can never corrupt the ASCII markers we're counting.
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(PAGE_OBJECT) ?? []).length;
}
