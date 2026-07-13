import { HttpUrlSchema } from "@/shared/schema";

// The ONE LaTeX-safety choke point (PLAN-RESUME.md decision 48, §4.8). The
// model never writes LaTeX; every interpolated profile/model string passes
// through escapeLatexText, so no `\`, `%`, `^^`, `\csname`, or `\input` can
// survive to form a control sequence — a whole-string escape, because
// blacklists provably lose to `\csname`/`^^` (risk 26). URL and email
// arguments get their own dedicated treatment (the `\href` contexts).

// The exact escape-latex@1.2.0 default table (asserted byte-for-byte in the
// test). Ten characters; `\`, `^`, `~` need a trailing `{}` so a run of them
// can't accidentally combine with the following glyph.
export const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  "^": "\\textasciicircum{}",
  _: "\\_",
  "%": "\\%",
  "~": "\\textasciitilde{}",
};

const ESCAPE_RE = /[\\{}$&#^_%~]/g;

// Zero-width / bidi / control characters that must never reach the engine
// (written as \u escapes so the source itself stays ASCII-reviewable): C0
// controls except \t (U+0009) and \n (U+000A) — those are kept and then
// collapsed to spaces —, DEL + C1 controls, soft hyphen, the Arabic letter
// mark, the ZW/directional marks, bidi embeddings/overrides, the word joiner,
// the bidi isolates, and the BOM. Bidi controls are a spoofing vector; the
// zero-width family is an invisible-payload vector.
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Escape an arbitrary string for a LaTeX text context. NFC-normalize (so a
 * decomposed payload can't dodge the map) -> strip invisibles/bidi controls
 * -> collapse all remaining whitespace (incl. the kept \t/\n and U+2028/U+2029
 * paragraph separators, which would otherwise inject `\par`) to single spaces
 * and trim -> apply the 10-char map in ONE pass (replacements are not
 * re-scanned, so `\`->`\textbackslash{}` never double-escapes its own braces).
 */
export function escapeLatexText(input: string): string {
  const normalized = input
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.replace(ESCAPE_RE, (ch) => LATEX_ESCAPES[ch]);
}

/**
 * Escape an http(s) URL for the FIRST argument of `\href{…}` (decision 48).
 * http(s)-only by construction — the identity email is the separate mailto
 * case, and callers pass schema-validated HttpUrls; the safeParse re-check is
 * defense-in-depth (a non-http(s) value yields an empty target rather than
 * emitting an unvalidated scheme).
 *
 * The `\href` argument is grabbed as a MACRO argument (renderResumeTex nests
 * it inside \resumeProjectHeading's tabular*), so hyperref's catcode
 * sanitisation never runs — every TeX-active character reaches the engine at
 * its OUTER catcode. WHATWG-valid URLs can carry any of them (increment-14
 * review, verified live on Tectonic 0.16.9):
 *   - `\ { }` open/close/synthesise a group or control word;
 *   - `^` forms the `^^XX` input-processor notation (`^^5c` -> a real
 *     backslash -> `\input{…}` filesystem read — the sentinel-proof residual);
 *   - `~` is the active tie, `_`/`$` are subscript/math-shift, `&` is an
 *     ALIGNMENT TAB that corrupts the surrounding tabular* (uncompilable .tex).
 * Percent-encode ALL of those (and spaces) first — the encodings are
 * RFC-3986-equivalent and server-decoded back — THEN escape every `%`
 * (including the ones just introduced) and every `#` (fragment), the two we
 * keep legible as `\%`/`\#` per decision 48.
 */
export function escapeLatexUrl(url: string): string {
  if (!HttpUrlSchema.safeParse(url).success) return "";
  return url
    .replace(/\\/g, "%5C")
    .replace(/\{/g, "%7B")
    .replace(/\}/g, "%7D")
    .replace(/\^/g, "%5E")
    .replace(/~/g, "%7E")
    .replace(/_/g, "%5F")
    .replace(/\$/g, "%24")
    .replace(/&/g, "%26")
    .replace(/ /g, "%20")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#");
}

// The v1 `mailtoEmail` shape discipline (draftHandoff.ts): '@' stays literal
// per RFC 6068. Kept verbatim as the shape gate.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// §4.8: a `%`-, quote-, brace-, backslash- or control-bearing address is
// "odd" and degrades to plain non-linked text — stricter than the bare shape
// check, the safe direction. The chars that survive this gate (`#`, `&`, `_`,
// `$`, `^`, `~`) are still LaTeX-escaped by escapeLatexText (decision 48's
// "escape-list at minimum"), so a valid-but-unusual address links safely.
const EMAIL_ODD = /[%"'`()<>[\]{},;:\\|\s]/;

/**
 * The identity email as a header field (decision 48). A clean addr-spec
 * renders `\href{mailto:<escaped-addr>}{<escaped-addr>}` — the target is
 * LaTeX-escaped but NOT percent-encoded (this is never escapeLatexUrl); an
 * odd/invalid address degrades to plain `escapeLatexText(email)` with no link.
 */
export function latexEmailField(email: string): string {
  const trimmed = email.trim();
  if (!EMAIL_SHAPE.test(trimmed) || EMAIL_ODD.test(trimmed)) {
    return escapeLatexText(email);
  }
  const escaped = escapeLatexText(trimmed);
  return `\\href{mailto:${escaped}}{${escaped}}`;
}
