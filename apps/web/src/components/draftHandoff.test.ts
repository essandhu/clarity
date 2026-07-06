import { describe, expect, it } from "vitest";
import { pastedListingRef, type ContactCandidate, type DraftNote } from "@/shared/schema";
import { hasEmailValue, mailtoEmail, mailtoHref } from "./draftHandoff";

const source = pastedListingRef("2026-07-06T12:00:00.000Z");

const candidate = (overrides: Partial<ContactCandidate>): ContactCandidate => ({
  channel: "listing",
  confidence: "public",
  source,
  ...overrides,
});

describe("mailtoEmail — decision 28's gate", () => {
  it("lets a public email through immediately", () => {
    expect(mailtoEmail(candidate({ value: "recruiting@acme.dev" }), false)).toBe(
      "recruiting@acme.dev",
    );
  });

  it("withholds a guessed email until the explicit accept click", () => {
    const guess = candidate({
      channel: "inferred-email",
      confidence: "guess",
      value: "jane.doe@acme.dev",
    });
    expect(mailtoEmail(guess, false)).toBeUndefined();
    expect(mailtoEmail(guess, true)).toBe("jane.doe@acme.dev");
  });

  it("never targets a non-email value, whatever the confidence", () => {
    expect(
      mailtoEmail(
        candidate({ channel: "linkedin", value: "https://www.linkedin.com/search?q=x" }),
        true,
      ),
    ).toBeUndefined();
    expect(mailtoEmail(candidate({ name: "Jane Doe", value: undefined }), true)).toBeUndefined();
    expect(mailtoEmail(null, true)).toBeUndefined();
  });
});

describe("hasEmailValue", () => {
  it("accepts an address and rejects URLs, names, and absence", () => {
    expect(hasEmailValue(candidate({ value: "a@b.co" }))).toBe(true);
    expect(hasEmailValue(candidate({ value: "https://a.co" }))).toBe(false);
    expect(hasEmailValue(candidate({ value: "Jane Doe" }))).toBe(false);
    expect(hasEmailValue(null)).toBe(false);
  });
});

describe("mailtoHref", () => {
  const note: DraftNote = {
    subject: "Backend Engineer at Acme & Co",
    body: "Hello,\nI saw your Rust post.\n\nBest,",
    groundedHooks: [],
  };

  it("percent-encodes subject and body, keeping the recipient's '@' literal (RFC 6068)", () => {
    const href = mailtoHref(note, "jane@acme.dev");
    expect(href).toBe(
      "mailto:jane@acme.dev?subject=Backend%20Engineer%20at%20Acme%20%26%20Co&body=Hello%2C%0AI%20saw%20your%20Rust%20post.%0A%0ABest%2C",
    );
  });

  it("builds an addressless mailto when no email is allowed in", () => {
    const href = mailtoHref({ body: "note", groundedHooks: [] });
    expect(href).toBe("mailto:?body=note");
  });
});
