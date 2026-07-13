import { describe, expect, it } from "vitest";
import { checkRephrase, REPHRASE_STOPLIST, stemsMatch, tokenizeWords } from "./rephraseGates";

// The §7.13 pinned gate fixtures. The corpus in most tests is the Driftlock
// mentoring bullet — deliberately Go-free and kubernetes-free so short
// lowercase fabrications have nothing to accidentally ground against.

const MENTORING = "Mentored four engineers through the platform team's on-call rotation redesign";
const INGEST =
  "Rebuilt the event ingestion pipeline in Go, cutting p99 latency from 900ms to 120ms";

function gate(candidate: string, opts: { source?: string; corpus?: string[]; role?: string[] } = {}) {
  const source = opts.source ?? MENTORING;
  return checkRephrase({
    candidate,
    sourceBullet: source,
    corpus: opts.corpus ?? [source, "Driftlock", "Senior Software Engineer"],
    roleTechnologies: opts.role ?? ["Go", "Kubernetes", "AWS"],
  });
}

describe("stemsMatch — the pinned suffix-strip rule", () => {
  it("matches across inflections: migrating ↔ migration", () => {
    expect(stemsMatch("migrating", "migration")).toBe(true);
  });
  it("matches plural ↔ singular via the prefix arm: services ↔ service", () => {
    expect(stemsMatch("services", "service")).toBe(true);
  });
  it("accidental shared prefixes do not ground: contract vs container", () => {
    expect(stemsMatch("contract", "container")).toBe(false);
  });
  it("accidental shared prefixes do not ground: distinct vs distributed", () => {
    expect(stemsMatch("distinct", "distributed")).toBe(false);
  });
  it("short stems never prefix-match: go vs gone", () => {
    expect(stemsMatch("go", "gone")).toBe(false);
  });
});

describe("checkRephrase — digit-run gate (gate 2)", () => {
  it('a fabricated "40%" fails with exactly that token named', () => {
    const verdict = gate("Rebuilt the event ingestion pipeline in Go cutting latency 40%", {
      source: INGEST,
      corpus: [INGEST, "Driftlock", "Senior Software Engineer"],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTokens).toEqual(["40%"]);
  });
  it("digit runs present in the source bullet pass, sentence punctuation ignored", () => {
    const verdict = gate("Rebuilt the pipeline in Go, cutting latency from 900ms to 120ms.", {
      source: INGEST,
      corpus: [INGEST, "Driftlock", "Senior Software Engineer"],
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("checkRephrase — significant-token gate (gate 3)", () => {
  it('lowercase "kubernetes" absent from the corpus reverts', () => {
    const verdict = gate("Mentored four engineers on kubernetes");
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTokens).toEqual(["kubernetes"]);
  });
  it('"Led", "ten", and "go" revert — not function words, absent from the corpus', () => {
    const verdict = gate("Led ten engineers to go");
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTokens).toEqual(expect.arrayContaining(["Led", "ten", "go"]));
    expect(verdict.offendingTokens).toHaveLength(3);
  });
  it('"the" and "and" pass on the stoplist', () => {
    expect(REPHRASE_STOPLIST.has("the")).toBe(true);
    expect(REPHRASE_STOPLIST.has("and")).toBe(true);
    expect(gate("Mentored the four engineers and the platform team").ok).toBe(true);
  });
  it('a lowercase short role tech ("aws") absent from the entry reverts', () => {
    const verdict = gate("Mentored four engineers on aws");
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTokens).toEqual(["aws"]);
  });
  it("symbol/cap-bearing tokens need outright corpus presence: gRPC fails, TypeScript grounds", () => {
    expect(gate("Rebuilt the pipeline in gRPC", {
      source: INGEST,
      corpus: [INGEST, "Driftlock", "Senior Software Engineer"],
    }).offendingTokens).toEqual(["gRPC"]);
    const billing = "Shipped the billing reconciliation service in TypeScript";
    expect(
      gate("Shipped the billing service in TypeScript", {
        source: billing,
        corpus: [billing, "Acme Analytics", "Software Engineer"],
      }).ok,
    ).toBe(true);
  });
  it("the corpus includes the entry's org/role/technologies, not just the bullet", () => {
    const verdict = gate("Renders one million points at 60fps with WebGL", {
      source: "Renders one million points at 60fps in the browser",
      corpus: [
        "Renders one million points at 60fps in the browser",
        "driftviz",
        "TypeScript",
        "D3",
        "WebGL",
      ],
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("checkRephrase — the role-term lock (namedTechnologies-scoped)", () => {
  it("a stoplisted token that stem-matches a role technology trips the lock", () => {
    const verdict = gate("Mentored four engineers via rotation", { role: ["via"] });
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTokens).toEqual(["via"]);
  });
  it("the same stoplisted token passes when no role technology matches it", () => {
    expect(gate("Mentored four engineers via rotation", { role: ["Go"] }).ok).toBe(true);
  });
  it("ordinary prepositions that also appear in the role AD survive — the lock is tech-scoped", () => {
    // "with"/"through" appear in any job ad; only namedTechnologies lock.
    expect(gate("Mentored four engineers with the platform team").ok).toBe(true);
  });
});

describe("tokenizeWords", () => {
  it("keeps token-internal dots and symbols, strips sentence-final dots, splits hyphens", () => {
    expect(tokenizeWords("Migrated to .NET and Node.js on-call rotation.")).toEqual([
      "Migrated",
      "to",
      ".NET",
      "and",
      "Node.js",
      "on",
      "call",
      "rotation",
    ]);
  });
});
