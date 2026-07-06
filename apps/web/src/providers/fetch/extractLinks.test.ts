import { describe, expect, it } from "vitest";
import {
  extractLinks,
  MAX_LINK_TEXT_CHARS,
  MAX_LINK_URL_CHARS,
  MAX_LINKS,
} from "./extractLinks";

const BASE = "https://acme.dev/about";

describe("extractLinks", () => {
  it("resolves relative hrefs against the final URL and collapses anchor text", () => {
    const links = extractLinks(
      `<a href="/careers">  Join
         our team  </a><a href="https://github.com/acme">GitHub</a>`,
      BASE,
    );
    expect(links).toEqual([
      { url: "https://acme.dev/careers", text: "Join our team" },
      { url: "https://github.com/acme", text: "GitHub" },
    ]);
  });

  it("drops non-http(s) schemes and unparseable hrefs", () => {
    const links = extractLinks(
      `<a href="mailto:jobs@acme.dev">mail</a>
       <a href="javascript:alert(1)">x</a>
       <a href="tel:+15551234">call</a>
       <a href="https://acme.dev/blog">Blog</a>`,
      BASE,
    );
    expect(links).toEqual([{ url: "https://acme.dev/blog", text: "Blog" }]);
  });

  it("strips fragments and dedups the resulting URLs", () => {
    const links = extractLinks(
      `<a href="/news#latest">News</a><a href="/news#older">Old news</a><a href="/news">All</a>`,
      BASE,
    );
    expect(links).toEqual([{ url: "https://acme.dev/news", text: "News" }]);
  });

  it("caps the number of links and the anchor-text length", () => {
    const anchors = Array.from(
      { length: MAX_LINKS + 50 },
      (_, i) => `<a href="/p/${i}">${"x".repeat(500)}</a>`,
    ).join("");
    const links = extractLinks(anchors, BASE);
    expect(links).toHaveLength(MAX_LINKS);
    expect(links[0]?.text).toHaveLength(MAX_LINK_TEXT_CHARS);
  });

  it("drops over-long URLs entirely — they reach the wire as step frames", () => {
    const mega = `https://acme.dev/?q=${"a".repeat(MAX_LINK_URL_CHARS)}`;
    const links = extractLinks(`<a href="${mega}">huge</a><a href="/ok">ok</a>`, BASE);
    expect(links).toEqual([{ url: "https://acme.dev/ok", text: "ok" }]);
  });

  it("returns [] for pages without anchors", () => {
    expect(extractLinks("<p>no links here</p>", BASE)).toEqual([]);
  });
});
