import { describe, expect, it } from "vitest";
import { firstEmail, inferEmailPatterns } from "./emailPattern";

describe("inferEmailPatterns", () => {
  it("produces first.last, first, and flast for a two-token name", () => {
    expect(inferEmailPatterns("Jane Doe", "acme.dev")).toEqual([
      { pattern: "first.last", value: "jane.doe@acme.dev" },
      { pattern: "first", value: "jane@acme.dev" },
      { pattern: "flast", value: "jdoe@acme.dev" },
    ]);
  });

  it("uses the LAST token as the surname for middle names", () => {
    expect(inferEmailPatterns("Mary Jane Watson", "acme.dev")[0].value).toBe(
      "mary.watson@acme.dev",
    );
  });

  it("strips diacritics and punctuation (an email is ASCII)", () => {
    expect(inferEmailPatterns("José Núñez-Smith", "acme.dev")[0].value).toBe(
      "jose.smith@acme.dev",
    );
  });

  it("falls back to first@ for a single-token name", () => {
    expect(inferEmailPatterns("Cher", "acme.dev")).toEqual([
      { pattern: "first", value: "cher@acme.dev" },
    ]);
  });

  it("normalizes the domain case and surrounding whitespace", () => {
    expect(inferEmailPatterns("Jane Doe", " Acme.DEV ")[0].value).toBe("jane.doe@acme.dev");
  });

  it("refuses a name that is already an email address", () => {
    expect(inferEmailPatterns("jobs@acme.dev", "acme.dev")).toEqual([]);
  });

  it("refuses a domain that is not shaped like a mail host", () => {
    expect(inferEmailPatterns("Jane Doe", "not a domain")).toEqual([]);
    expect(inferEmailPatterns("Jane Doe", "localhost")).toEqual([]);
    expect(inferEmailPatterns("Jane Doe", "")).toEqual([]);
  });

  it("refuses a name with no alphabetic tokens", () => {
    expect(inferEmailPatterns("12345", "acme.dev")).toEqual([]);
    expect(inferEmailPatterns("  ", "acme.dev")).toEqual([]);
  });
});

describe("firstEmail", () => {
  it("finds the first email-shaped substring", () => {
    expect(firstEmail("Reach recruiting@acme.dev or hr@acme.dev")).toBe("recruiting@acme.dev");
  });

  it("finds an email inside surrounding punctuation", () => {
    expect(firstEmail("Jane Doe <jane.doe@acme.dev>")).toBe("jane.doe@acme.dev");
  });

  it("returns undefined when nothing is email-shaped", () => {
    expect(firstEmail("apply via our careers page")).toBeUndefined();
  });
});
