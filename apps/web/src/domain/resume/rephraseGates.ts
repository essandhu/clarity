// Gates 2–3 of the never-fabricate fold (PLAN-RESUME.md §4.2), pure and
// prompt-free — pre-split from tailorGrounding.ts under the ~200-line
// ceiling (the tierDispatch precedent). Every rule here is a pinned named
// constant (risk 19: tunable without touching the pipeline), and the driver
// re-runs these exact functions client-side over the live wire.

/**
 * The closed function-word stoplist (§4.2 gate 3): pure function words ONLY —
 * ambiguous words that double as technology or claim words ("go", "led",
 * "ten", "rust") are deliberately excluded, so they must ground in the
 * source bullet like any content word.
 */
export const REPHRASE_STOPLIST: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "both", "but",
  "by", "did", "do", "does", "during", "each", "for", "from", "had", "has",
  "have", "in", "into", "is", "it", "its", "nor", "not", "of", "on", "onto",
  "or", "our", "over", "per", "so", "such", "than", "that", "the", "their",
  "then", "these", "this", "those", "through", "to", "under", "across",
  "via", "was", "we", "were", "which", "while", "who", "with", "within",
  "without",
]);

// The pinned closed inflectional-suffix list (§4.2 gate 3), longest-first so
// a token strips exactly one, deterministically.
const STEM_SUFFIXES = ["ions", "ing", "ers", "ion", "es", "ed", "er", "s"] as const;

/** Metric-fabrication kill (§4.2 gate 2): every maximal digit-run token in a
 *  rephrase must appear verbatim in the SOURCE bullet. */
const DIGIT_RUN = /\d[\d,.%$+kKmMxX]*/g;

// Word-ish tokens: letters/digits with token-internal ./+/# kept (".NET",
// "Node.js", "C++", "C#"); hyphens SPLIT ("on-call" grounds word-by-word).
const TOKEN = /[A-Za-z0-9.+#]+/g;

export function stemToken(token: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (token.length > suffix.length && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/** The pinned stem rule: strip one suffix from each side, then equality OR a
 *  prefix relation whose shorter stem is ≥ 4 chars — "migrating"↔"migration"
 *  passes; "contract"/"container" and "distinct"/"distributed" do not. */
export function stemsMatch(a: string, b: string): boolean {
  const stemA = stemToken(a);
  const stemB = stemToken(b);
  if (stemA === stemB) return true;
  const [short, long] = stemA.length <= stemB.length ? [stemA, stemB] : [stemB, stemA];
  return short.length >= 4 && long.startsWith(short);
}

export function tokenizeWords(text: string): string[] {
  return (text.match(TOKEN) ?? [])
    .map((token) => token.replace(/\.+$/, "")) // sentence-final dots, not ".NET"'s
    .filter((token) => token.length > 0);
}

/** Digit-, dot-, internal-cap-, or symbol-bearing tokens (k8s, .NET, gRPC,
 *  C++) never stem: they must appear in the corpus outright (§4.2 gate 3). */
function isStemmable(token: string): boolean {
  return /^[a-z]+$/i.test(token) && !/[A-Z]/.test(token.slice(1));
}

export interface RephraseVerdict {
  ok: boolean;
  /** The exact tokens that failed, original casing, each ≤ 60 chars — carried
   *  on the reverted bullet so the UI can name what was blocked. */
  offendingTokens: string[];
}

/**
 * Gates 2 + 3 over one rephrased bullet. The grounding corpus is the source
 * bullet ∪ that entry's org/role/technologies — NEVER the role profile: the
 * job ad's stack cannot leak into a bullet as claimed experience, even
 * lowercase and short ("aws", "go"). The role-term lock (namedTechnologies-
 * scoped) trips leak-shaped tokens even when stoplisted.
 */
export function checkRephrase(args: {
  candidate: string;
  sourceBullet: string;
  corpus: readonly string[];
  roleTechnologies: readonly string[];
}): RephraseVerdict {
  const corpusText = args.corpus.join("\n").toLowerCase();
  const corpusTokens = new Set(tokenizeWords(corpusText));
  const roleTokens = new Set(
    args.roleTechnologies.flatMap((tech) => tokenizeWords(tech.toLowerCase())),
  );
  const seen = new Set<string>();
  const offending: string[] = [];
  const offend = (token: string) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    offending.push(token.slice(0, 60));
  };

  // Gate 2 — digit runs, verbatim against the source bullet only. Trailing
  // sentence punctuation is stripped from the match ("…by 40%." must not
  // fail on the full stop), never from the middle ("3.5" stays whole).
  for (const match of args.candidate.matchAll(DIGIT_RUN)) {
    const run = match[0].replace(/[.,]+$/, "");
    if (run.length > 0 && !args.sourceBullet.includes(run)) offend(run);
  }

  // Gate 3 — the significant-token subset gate, regardless of length, case,
  // or sentence position ("Led", "ten", "go" must ground; "the" passes).
  for (const token of tokenizeWords(args.candidate)) {
    const lower = token.toLowerCase();
    // Tokens that ARE digit runs are wholly gate 2's jurisdiction — a failed
    // "40%" must be named once, not echoed again as "40".
    if (/^\d[\d,.%$+kKmMxX]*$/.test(token)) continue;
    if (!isStemmable(token)) {
      if (!corpusText.includes(lower)) offend(token);
      continue;
    }
    const grounded = groundsIn(lower, corpusTokens);
    if (grounded) continue;
    if (!REPHRASE_STOPLIST.has(lower)) {
      offend(token);
    } else if (groundsIn(lower, roleTokens)) {
      offend(token); // the role-term lock: stoplisted but leak-shaped
    }
  }

  return { ok: offending.length === 0, offendingTokens: offending };
}

function groundsIn(lower: string, tokens: ReadonlySet<string>): boolean {
  if (tokens.has(lower)) return true;
  for (const candidate of tokens) {
    if (stemsMatch(lower, candidate)) return true;
  }
  return false;
}
