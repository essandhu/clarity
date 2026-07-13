import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RenderRequestSchema, type TailoredResume } from "@/shared/schema";
import {
  escapeLatexText,
  escapeLatexUrl,
  latexEmailField,
  LATEX_ESCAPES,
} from "./latexEscape";
import { RESUME_PREAMBLE } from "./resumePreamble";
import { renderResumeTex, resumeFilenameSlug } from "./resumeLatex";

// Increment 14 — LaTeX generation. The model never writes LaTeX; these tests
// pin the escaper table byte-for-byte against escape-latex@1.2.0, prove every
// safety-brief injection primitive renders inert, and lock the template output
// to a golden .tex (regenerate deliberately, never on a whim).

const PROVENANCE = { origin: "manual" as const, importedAt: "2026-07-12T00:00:00.000Z" };

/** A comprehensive TailoredResume exercising every section + both link kinds
 *  (identity mailto + http links, a linked project). The golden .tex is
 *  regenerated from EXACTLY this via scripts/tailorProofs (see the golden
 *  test below). */
export const GOLDEN_RESUME: TailoredResume = {
  roleLabel: "Backend Engineer at Driftlock",
  identity: {
    name: "Maya Chen",
    email: "maya.chen@example.com",
    phone: "+1 (555) 010-2020",
    location: "Lisbon, Portugal",
    links: [
      { label: "GitHub", url: "https://github.com/mayachen" },
      { label: "Portfolio", url: "https://mayachen.dev" },
    ],
  },
  entries: [
    {
      entryId: "exp-driftlock",
      kind: "experience",
      heading: "Driftlock",
      subheading: "Senior Software Engineer",
      location: "Lisbon, Portugal",
      dates: "Jan 2022 -- Present",
      bullets: [
        {
          bulletId: "b-ingest",
          text: "Rebuilt the event ingestion pipeline in Go, cutting p99 latency from 900ms to 120ms",
          disposition: "verbatim",
        },
        {
          bulletId: "b-migration",
          text: "Led the migration of 14 services from a shared Postgres cluster to per-service databases",
          disposition: "rephrased",
        },
      ],
    },
    {
      entryId: "exp-acme",
      kind: "experience",
      heading: "Acme Analytics",
      subheading: "Software Engineer",
      location: "Porto, Portugal",
      dates: "Jun 2018 -- Dec 2021",
      bullets: [
        {
          bulletId: "b-billing",
          text: "Shipped the billing reconciliation service handling 2M invoices per month in TypeScript",
          disposition: "verbatim",
        },
      ],
    },
    {
      entryId: "proj-driftviz",
      kind: "project",
      heading: "driftviz",
      subheading: "TypeScript, D3, WebGL",
      url: "https://github.com/mayachen/driftviz",
      bullets: [
        {
          bulletId: "b-render",
          text: "Renders one million points at 60fps in the browser",
          disposition: "verbatim",
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-lisbon",
      school: "University of Lisbon",
      degree: "BSc Computer Science",
      startDate: "2014",
      endDate: "2018",
      notes: "Graduated with honours; thesis on stream processing",
      provenance: PROVENANCE,
    },
  ],
  skills: [
    { id: "sk-lang", category: "Languages", items: ["Go", "TypeScript", "Python", "SQL"] },
    { id: "sk-infra", category: "Infrastructure", items: ["Postgres", "Kafka", "Docker", "AWS"] },
  ],
};

describe("LATEX_ESCAPES table", () => {
  it("is byte-equal to escape-latex@1.2.0's default map", () => {
    expect(LATEX_ESCAPES).toEqual({
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
    });
  });
});

describe("escapeLatexText", () => {
  it("renders every safety-brief injection primitive inert", () => {
    const cases: [string, string][] = [
      ["\\input{C:/secret}", "\\textbackslash{}input\\{C:/secret\\}"],
      ["\\immediate\\write18{rm}", "\\textbackslash{}immediate\\textbackslash{}write18\\{rm\\}"],
      ["\\csname foo\\endcsname", "\\textbackslash{}csname foo\\textbackslash{}endcsname"],
      ["^^70", "\\textasciicircum{}\\textasciicircum{}70"],
      ["50% off", "50\\% off"],
      ["a & b # c $ d _ e ~ f", "a \\& b \\# c \\$ d \\_ e \\textasciitilde{} f"],
    ];
    for (const [input, expected] of cases) {
      expect(escapeLatexText(input)).toBe(expected);
    }
  });

  it("NFC-normalizes so a decomposed payload can't dodge the map", () => {
    // "e" + combining acute (U+0301) normalizes to precomposed U+00E9.
    expect(escapeLatexText("e\u0301")).toBe("\u00e9");
  });

  it("strips zero-width and bidi controls", () => {
    // ZWSP, RIGHT-TO-LEFT OVERRIDE, BOM interleaved with plain text.
    expect(escapeLatexText("a\u200Bb\u202Ec\uFEFFd")).toBe("abcd");
  });

  it("collapses tabs, newlines and paragraph separators to single spaces (no \\par)", () => {
    expect(escapeLatexText("one\n\ntwo\tthree four")).toBe("one two three four");
  });

  it("does not double-escape its own replacement braces", () => {
    // A run of backslashes each becomes \textbackslash{}; the {} in the
    // replacement is never re-scanned.
    expect(escapeLatexText("\\\\")).toBe("\\textbackslash{}\\textbackslash{}");
  });
});

describe("escapeLatexUrl", () => {
  it("percent-encodes braces/backslash/space then escapes %/# (http(s)-only)", () => {
    expect(escapeLatexUrl("https://ex.com/a{b}\\c d#e%f")).toBe(
      "https://ex.com/a\\%7Bb\\%7D\\%5Cc\\%20d\\#e\\%f",
    );
  });

  it("neutralizes ^ (^^ input-processor notation), ~, _, $ (review HIGH)", () => {
    // ^^5c would otherwise synthesize a real backslash -> control sequence.
    expect(escapeLatexUrl("https://ex.com/a^^5cb~c_d$e")).toBe(
      "https://ex.com/a\\%5E\\%5E5cb\\%7Ec\\%5Fd\\%24e",
    );
    const out = escapeLatexUrl("https://ex.com/^^5cinput{x}");
    expect(out).not.toContain("^"); // no caret survives
    expect(out).not.toContain("{"); // no live group
  });

  it("percent-encodes & (a raw & is an alignment tab in the project tabular*)", () => {
    expect(escapeLatexUrl("https://ex.com/a?x=1&y=2")).toBe("https://ex.com/a?x=1\\%26y=2");
    expect(escapeLatexUrl("https://ex.com/a?x=1&y=2")).not.toContain("&");
  });

  it("leaves a clean URL untouched", () => {
    expect(escapeLatexUrl("https://github.com/mayachen")).toBe("https://github.com/mayachen");
  });

  it("returns an empty target for a non-http(s) value (defense-in-depth)", () => {
    expect(escapeLatexUrl("javascript:alert(1)")).toBe("");
    expect(escapeLatexUrl("mailto:a@b.com")).toBe("");
  });
});

describe("latexEmailField (decision 48 mailto rule)", () => {
  it("links a clean addr-spec with '@' literal", () => {
    expect(latexEmailField("maya.chen@example.com")).toBe(
      "\\href{mailto:maya.chen@example.com}{maya.chen@example.com}",
    );
  });

  it("escapes a TeX-special-but-valid char (underscore) inside the link", () => {
    expect(latexEmailField("first_last@x.io")).toBe(
      "\\href{mailto:first\\_last@x.io}{first\\_last@x.io}",
    );
  });

  it("degrades an odd address (%, quote, CRLF, no-@) to plain non-linked text", () => {
    expect(latexEmailField("a%b@x.com")).toBe("a\\%b@x.com");
    expect(latexEmailField('"a"@x.com')).toBe('"a"@x.com');
    expect(latexEmailField("a\r\nb@x.com")).toBe("a b@x.com");
    expect(latexEmailField("notanemail")).toBe("notanemail");
    expect(latexEmailField("a@b")).toBe("a@b"); // no dot
  });
});

describe("resumeFilenameSlug", () => {
  it("slugifies a normal role label", () => {
    expect(resumeFilenameSlug("Backend Engineer at Driftlock")).toBe(
      "backend-engineer-at-driftlock",
    );
  });

  it("folds accents and collapses hostile punctuation to a safe [a-z0-9-] slug", () => {
    const slug = resumeFilenameSlug('Señor "Dev"\r\n<script> @ Café/Inc.');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toContain("senor");
    expect(slug).toContain("cafe");
  });

  it("falls back to 'resume' when nothing survives", () => {
    expect(resumeFilenameSlug("株式会社")).toBe("resume");
    expect(resumeFilenameSlug("!!! ---")).toBe("resume");
    expect(resumeFilenameSlug("")).toBe("resume");
  });

  it("caps length and trims a severed trailing dash", () => {
    expect(resumeFilenameSlug("a".repeat(200)).length).toBeLessThanOrEqual(60);
    // A word boundary exactly at the cap severs right after a dash — the
    // post-slice trim (not the pre-slice one) must remove it (review LOW).
    const severed = resumeFilenameSlug("a".repeat(59) + " bbbbb");
    expect(severed).toBe("a".repeat(59));
    expect(severed.endsWith("-")).toBe(false);
  });
});

describe("renderResumeTex", () => {
  const goldenPath = fileURLToPath(
    new URL("../../../fixtures/resume/tailored.golden.tex", import.meta.url),
  );

  it("matches the golden .tex byte-for-byte", () => {
    const golden = readFileSync(goldenPath, "utf8");
    expect(renderResumeTex(GOLDEN_RESUME)).toBe(golden);
  });

  it("never emits fontawesome (the Tectonic crash class)", () => {
    expect(RESUME_PREAMBLE.toLowerCase()).not.toContain("fontawesome");
    expect(renderResumeTex(GOLDEN_RESUME).toLowerCase()).not.toContain("fontawesome");
  });

  it("omits empty sections entirely", () => {
    const bare: TailoredResume = {
      roleLabel: "X at Y",
      identity: { name: "Solo", links: [] },
      entries: [],
      education: [],
      skills: [],
    };
    const tex = renderResumeTex(bare);
    expect(tex).not.toContain("\\section{Education}");
    expect(tex).not.toContain("\\section{Experience}");
    expect(tex).not.toContain("\\section{Projects}");
    expect(tex).not.toContain("\\section{Technical Skills}");
    // No \small contact line when identity has only a name.
    expect(tex).toContain("\\textbf{\\Huge \\scshape Solo}");
    expect(tex).not.toContain("\\small $");
    // Still a valid, closed document.
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("\\end{document}");
  });

  it("omits the bullet list for a bullet-less entry (no empty itemize)", () => {
    const noBullets: TailoredResume = {
      roleLabel: "X at Y",
      identity: { name: "Solo", links: [] },
      entries: [{ entryId: "e1", kind: "experience", heading: "Org", subheading: "Role", bullets: [] }],
      education: [],
      skills: [],
    };
    // The BODY only — the preamble DEFINES \resumeItemListStart via \newcommand.
    const body = renderResumeTex(noBullets).split("\\begin{document}")[1];
    expect(body).toContain("\\section{Experience}");
    expect(body).not.toContain("\\resumeItemListStart");
  });

  it("renders every per-field injection payload as inert literal text", () => {
    const payload = "\\input{x} \\write18 \\csname z ^^41 %INJECTMARK $ & # _ ~ { }";
    const hostile: TailoredResume = {
      roleLabel: "X at Y",
      identity: {
        name: payload,
        email: payload, // odd -> plain escaped text
        phone: payload,
        location: payload,
        // URL slots carry hostile-but-HttpUrl-valid values (review HIGH: these
        // were the ONLY interpolated fields never given a payload). Braces
        // would break the \href group; \input would fire on a group break.
        links: [{ label: payload.slice(0, 60), url: "https://ex.com/}{\\input{/etc/passwd}}" }],
      },
      entries: [
        {
          entryId: "e1",
          kind: "experience",
          heading: payload,
          subheading: payload,
          location: payload,
          dates: payload,
          bullets: [{ bulletId: "b1", text: payload, disposition: "verbatim" }],
        },
        {
          entryId: "p1",
          kind: "project",
          heading: payload,
          subheading: payload,
          url: "https://ex.com/a?x=1&y=2^^5cinput{z}", // & (alignment tab) + ^^ + braces
          bullets: [{ bulletId: "b2", text: payload, disposition: "verbatim" }],
        },
      ],
      education: [
        {
          id: "ed1",
          school: payload,
          degree: payload,
          location: payload,
          startDate: payload.slice(0, 40),
          endDate: payload.slice(0, 40),
          provenance: PROVENANCE,
        },
      ],
      skills: [{ id: "s1", category: payload.slice(0, 80), items: [payload.slice(0, 80)] }],
    };
    const tex = renderResumeTex(hostile);
    const body = tex.split("\\begin{document}")[1];
    // No user backslash survived to form a control sequence in the BODY.
    for (const danger of ["\\input{", "\\write18", "\\csname", "\\catcode", "^^"]) {
      expect(body).not.toContain(danger);
    }
    // No LIVE comment: every user '%' became '\%' (a bare %INJECTMARK would
    // eat the rest of its line). The escaped form '\%INJECTMARK' is allowed.
    expect(/(?<!\\)%INJECTMARK/.test(body)).toBe(false);
    // The payload IS present, as inert escaped glyphs (nothing was dropped).
    expect(body).toContain("\\textbackslash{}input");
    expect(body).toContain("\\%INJECTMARK");

    // Every \href target (mailto + both hostile URLs) is free of raw group /
    // control / alignment-tab characters — a target has no raw braces after
    // escaping, so this regex captures each fully (review HIGH).
    const targets = [...tex.matchAll(/\\href\{([^{}]*)\}\{/g)].map((m) => m[1]);
    // The hostile email is odd -> plain text (no mailto href), leaving the two
    // hostile URL hrefs (identity link + project url).
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const target of targets) {
      // Only \% and \# are legitimate backslashes in a target; nothing else.
      expect(target.replace(/\\[%#]/g, "")).not.toContain("\\");
      expect(target).not.toContain("^^"); // no caret input-processor notation
      expect(target).not.toMatch(/(?<!\\)&/); // no raw alignment-tab ampersand
      expect(target).not.toContain("\\input"); // no group-break -> \input
    }
    // The brace-break URL was encoded (its raw prefix never appears).
    expect(body).not.toContain("https://ex.com/}");
  });
});

describe("RenderRequestSchema", () => {
  it("accepts a tex or pdf request", () => {
    expect(RenderRequestSchema.safeParse({ resume: GOLDEN_RESUME, format: "tex" }).success).toBe(
      true,
    );
    expect(
      RenderRequestSchema.safeParse({
        resume: GOLDEN_RESUME,
        format: "pdf",
        allowBundleDownload: true,
      }).success,
    ).toBe(true);
  });

  it("rejects a body smuggling a raw `tex` field (.strict — decision 49)", () => {
    const result = RenderRequestSchema.safeParse({
      resume: GOLDEN_RESUME,
      format: "tex",
      tex: "\\immediate\\write18{rm -rf /}",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing resume", () => {
    expect(RenderRequestSchema.safeParse({ format: "tex" }).success).toBe(false);
  });
});
