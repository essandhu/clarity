import { describe, expect, it } from "vitest";
import { cheerioStrip } from "./cheerioStrip";
import { MIN_TEXT_CHARS, readabilityClean } from "./readabilityClean";

const PARAGRAPH =
  "We are building the collaborative editor for regulated industries, and our " +
  "customers include three of the five largest insurers in Europe. The team is " +
  "small, senior, and remote-first, and we ship to production every day.";

const articleHtml = `<html><head><title>Acme — Blog</title></head><body>
  <article>
    <h1>How we ship</h1>
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
  </article>
</body></html>`;

const sparseCareersHtml = `<html><head><title>Careers at Acme</title>
  <style>.x { color: red }</style></head><body>
  <script>window.__NOISE__ = "tracking-blob-not-page-text";</script>
  <div class="jobs">
    <ul>
      <li>Senior Platform Engineer — Remote (EU). ${PARAGRAPH}</li>
      <li>Founding Product Designer — Berlin or remote.</li>
    </ul>
    <footer>Questions? Write to recruiting@acme.dev — we answer within a week.</footer>
  </div>
</body></html>`;

describe("readabilityClean — routing", () => {
  it("extracts article-shaped pages (title from <title>, prose in text)", () => {
    const outcome = readabilityClean(articleHtml, "https://acme.dev/blog/shipping");
    expect(outcome.kind).toBe("cleaned");
    if (outcome.kind !== "cleaned") return;
    expect(outcome.title).toBe("Acme — Blog");
    expect(outcome.text).toContain("regulated industries");
  });

  it("falls back to the cheerio strip on non-readerable pages, dropping script/style noise", () => {
    const outcome = readabilityClean(sparseCareersHtml, "https://acme.dev/careers");
    expect(outcome.kind).toBe("cleaned");
    if (outcome.kind !== "cleaned") return;
    expect(outcome.title).toBe("Careers at Acme");
    expect(outcome.text).toContain("Senior Platform Engineer");
    expect(outcome.text).toContain("recruiting@acme.dev"); // footer contacts are kept
    expect(outcome.text).not.toContain("tracking-blob-not-page-text");
    expect(outcome.text).not.toContain("color: red");
  });
});

describe("readabilityClean — soft-404 / empty-content heuristics", () => {
  it("flags a page whose cleaned text is too short to ground anything", () => {
    const outcome = readabilityClean(
      "<html><head><title>Careers</title></head><body>Nothing here yet.</body></html>",
      "https://thin.test/careers",
    );
    expect(outcome).toMatchObject({ kind: "thin" });
  });

  it("flags a soft 404 by title even when the body is long", () => {
    const filler = PARAGRAPH.repeat(4);
    const outcome = readabilityClean(
      `<html><head><title>404 Not Found</title></head><body><p>${filler}</p></body></html>`,
      "https://soft404.test/gone",
    );
    expect(outcome.kind).toBe("thin");
    if (outcome.kind !== "thin") return;
    expect(outcome.detail).toMatch(/error page/i);
  });

  it("accepts a page right at the minimum-length boundary", () => {
    const body = "x".repeat(MIN_TEXT_CHARS);
    const outcome = readabilityClean(
      `<html><head><title>Acme</title></head><body>${body}</body></html>`,
      "https://boundary.test/",
    );
    expect(outcome.kind).toBe("cleaned");
  });
});

describe("cheerioStrip — block boundaries", () => {
  it("separates adjacent block elements so words never jam together", () => {
    const { text } = cheerioStrip(
      `<html><head><title>Jobs</title></head><body>
        <div>143 jobs</div><div>Engineering</div>
        <table><tr><td>Backend Engineer</td><td>Remote</td></tr></table>
        <ul><li>First role</li><li>Second role</li></ul>
        Line one<br>Line two
      </body></html>`,
    );
    expect(text).not.toContain("jobsEngineering");
    expect(text).not.toContain("EngineerRemote");
    expect(text).not.toContain("roleSecond");
    expect(text).not.toContain("oneLine");
    expect(text).toContain("143 jobs");
    expect(text).toContain("Backend Engineer");
  });
});

describe("cheerioStrip", () => {
  it("extracts the <title> and body text without head/script/style/nav content", () => {
    const { title, text } = cheerioStrip(
      `<html><head><title>Acme</title><style>.a{}</style></head><body>
        <nav>Home About Careers</nav>
        <main>We make developer tools.</main>
        <script>var hidden = 1;</script>
        <footer>hello@acme.dev</footer>
      </body></html>`,
    );
    expect(title).toBe("Acme");
    expect(text).toContain("We make developer tools.");
    expect(text).toContain("hello@acme.dev");
    expect(text).not.toContain("var hidden");
    expect(text).not.toContain("Home About Careers");
    expect(text).not.toContain("Acme\nHome"); // title text is not in body text
  });
});
