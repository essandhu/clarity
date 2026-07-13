// Pure, dependency-free word-level diff (decision 41): the "what changed vs
// master" tab renders rephrased bullets as master-vs-rephrase spans. Inputs
// are bullets (≤ 500 chars), so the quadratic LCS table stays tiny.

export interface DiffSpan {
  kind: "same" | "added" | "removed";
  text: string;
}

export function wordDiff(before: string, after: string): DiffSpan[] {
  const a = words(before);
  const b = words(after);
  // LCS length table: lcs[i][j] = LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const spans: DiffSpan[] = [];
  const push = (kind: DiffSpan["kind"], text: string) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text = `${last.text} ${text}`;
    else spans.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return spans;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}
