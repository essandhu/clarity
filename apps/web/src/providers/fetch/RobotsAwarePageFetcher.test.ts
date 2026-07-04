import { describe, expect, it } from "vitest";
import { CleanPageSchema, FetchSkipSchema } from "@/shared/schema";
import { systemClock } from "@/domain/pipeline/clock";
import { createRunBudget, type BudgetToken } from "@/domain/pipeline/RunBudget";
import { ATTEMPTS_PER_FETCH } from "./resilience";
import { MAX_BODY_BYTES, RobotsAwarePageFetcher } from "./RobotsAwarePageFetcher";

// End-to-end through the gate chain with an injected fetch stub — no network.
// Every test uses a unique origin: robots cache, breakers, and limiters are
// deliberately process-global.

const token = (timeoutMs = 5_000, signal = new AbortController().signal): BudgetToken => ({
  timeoutMs,
  signal,
});

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const PAGE_HTML = `<html><head><title>Acme Careers</title></head><body><main>
  ${"We build collaboration tools for regulated teams. ".repeat(12)}
  Reach us at recruiting@acme.dev.
</main></body></html>`;

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(page: Handler, robots?: Handler) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) {
      return robots ? robots(url, init) : new Response("nf", { status: 404 });
    }
    return page(url, init);
  }) as typeof fetch;
  return { impl, calls, pageCalls: () => calls.filter((u) => !u.endsWith("/robots.txt")) };
}

const hangUntilAborted: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
      { once: true },
    );
  });

describe("RobotsAwarePageFetcher — clean pages", () => {
  it("returns a schema-valid CleanPage for a healthy HTML page", async () => {
    const { impl } = stubFetch(() => new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS }));
    const result = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-happy.test/careers",
      token(),
    );
    const page = CleanPageSchema.parse(result);
    expect(page.title).toBe("Acme Careers");
    expect(page.text).toContain("regulated teams");
    expect(page.finalUrl).toBe("https://f-happy.test/careers"); // stub Response.url is empty → fallback
  });

  it("reports the redirect-resolved finalUrl when the response carries one", async () => {
    const res = new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS });
    Object.defineProperty(res, "url", { value: "https://f-redirect.test/careers/open" });
    const { impl } = stubFetch(() => res);
    const result = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-redirect.test/careers",
      token(),
    );
    expect(CleanPageSchema.parse(result).finalUrl).toBe("https://f-redirect.test/careers/open");
  });
});

describe("RobotsAwarePageFetcher — every failure mode is a typed skip, never a throw", () => {
  it("robots disallow: skips without ever dispatching the page fetch", async () => {
    const { impl, pageCalls } = stubFetch(
      () => new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS }),
      () => new Response("User-agent: *\nDisallow: /", { status: 200 }),
    );
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-blocked.test/careers",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "robots_disallowed" });
    expect(pageCalls()).toHaveLength(0);
  });

  it("HTTP error status: http_status with the code, after the retry sequence", async () => {
    const { impl, pageCalls } = stubFetch(() => new Response("gone", { status: 404, headers: HTML_HEADERS }));
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-404.test/careers",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "http_status", httpStatus: 404 });
    expect(pageCalls()).toHaveLength(ATTEMPTS_PER_FETCH);
  });

  it("hung host: aggressive per-attempt timeout → timeout skip", async () => {
    const { impl } = stubFetch(hangUntilAborted);
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-hang.test/careers",
      token(60),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "timeout" });
  });

  it("dead host: network skip carrying the failure detail", async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND f-dead.test") });
    });
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-dead.test/careers",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "network" });
    expect(skip.kind === "skip" && skip.detail).toContain("ENOTFOUND");
  });

  it("declared non-HTML content type → not_html", async () => {
    const { impl } = stubFetch(
      () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-pdf.test/brochure",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "not_html" });
  });

  it("oversized content-length header → too_large without reading the body", async () => {
    const { impl } = stubFetch(
      () =>
        new Response("tiny", {
          status: 200,
          headers: { ...HTML_HEADERS, "content-length": String(MAX_BODY_BYTES + 1) },
        }),
    );
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-big-header.test/page",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "too_large" });
  });

  it("oversized streamed body without content-length → too_large at the read cap", async () => {
    const bigBody = "<html><body>" + "x".repeat(MAX_BODY_BYTES + 1024) + "</body></html>";
    const { impl } = stubFetch(() => new Response(bigBody, { status: 200, headers: HTML_HEADERS }));
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-big-body.test/page",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "too_large" });
  });

  it("thin page → empty_content (honest not-found beats a false found)", async () => {
    const { impl } = stubFetch(
      () =>
        new Response("<html><head><title>Careers</title></head><body>Soon.</body></html>", {
          status: 200,
          headers: HTML_HEADERS,
        }),
    );
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-thin.test/careers",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "empty_content" });
  });

  it("pre-aborted token → cancelled with zero dispatches (not even robots)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));
    const { impl, calls } = stubFetch(() => new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS }));
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-preabort.test/careers",
      token(5_000, controller.signal),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("user abort mid-fetch → cancelled, never mislabelled as a host timeout", async () => {
    const controller = new AbortController();
    const { impl } = stubFetch(hangUntilAborted);
    const pending = new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-midabort.test/careers",
      token(5_000, controller.signal),
    );
    setTimeout(() => controller.abort(new Error("user cancelled the run")), 30);
    const skip = await pending;
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "cancelled" });
    expect(skip.kind === "skip" && skip.detail).toContain("user cancelled");
  });

  it("parseable non-http(s) URLs (mailto:, javascript:) → schema-valid skip, zero dispatches", async () => {
    const { impl, calls } = stubFetch(() => new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS }));
    const fetcher = new RobotsAwarePageFetcher(impl);
    for (const bad of ["mailto:jobs@acme.dev", "javascript:void(0)", "ftp://files.acme.dev/x"]) {
      const skip = await fetcher.fetchClean(bad, token());
      expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "network" });
      expect(skip.kind === "skip" && skip.url).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("cross-origin redirect to a robots-disallowed origin → skip, content unused", async () => {
    const res = new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS });
    Object.defineProperty(res, "url", { value: "https://f-redirect-blocked.test/landing" });
    const { impl } = stubFetch(
      () => res,
      (url) =>
        url.startsWith("https://f-redirect-blocked.test")
          ? new Response("User-agent: *\nDisallow: /", { status: 200 })
          : new Response("nf", { status: 404 }), // original origin allows
    );
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-redirect-src.test/careers",
      token(),
    );
    expect(FetchSkipSchema.parse(skip)).toMatchObject({
      reason: "robots_disallowed",
      url: "https://f-redirect-src.test/careers",
    });
    expect(skip.kind === "skip" && skip.detail).toContain("redirected to");
  });

  it("garbage URL → schema-valid typed skip (no url field), no throw", async () => {
    const { impl, calls } = stubFetch(() => new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS }));
    const skip = await new RobotsAwarePageFetcher(impl).fetchClean("not a url", token());
    // Must round-trip the wire schema: a non-URL can't sit in `url`.
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "network" });
    expect(skip.kind === "skip" && skip.url).toBeUndefined();
    expect(skip.kind === "skip" && skip.detail).toContain("not a url");
    expect(calls).toHaveLength(0);
  });

  it("run deadline firing mid-fetch → cancelled skip naming the deadline", async () => {
    const { impl } = stubFetch(hangUntilAborted);
    const budget = createRunBudget({ maxFetches: 3, deadlineMs: 60_000 }, systemClock);
    const budgetToken = budget.tryAcquire("deadline test");
    expect(budgetToken).not.toBeNull();
    const pending = new RobotsAwarePageFetcher(impl).fetchClean(
      "https://f-deadline.test/careers",
      budgetToken!,
    );
    setTimeout(() => budget.fireDeadline(), 30);
    const skip = await pending;
    expect(FetchSkipSchema.parse(skip)).toMatchObject({ reason: "cancelled" });
    expect(skip.kind === "skip" && skip.detail).toMatch(/deadline/i);
  });

  it("honors robots Crawl-delay: same-host page fetches are spaced by it", async () => {
    const pageStarts: number[] = [];
    const { impl } = stubFetch(
      () => {
        pageStarts.push(Date.now());
        return new Response(PAGE_HTML, { status: 200, headers: HTML_HEADERS });
      },
      () => new Response("User-agent: *\nCrawl-delay: 1.5\nDisallow:", { status: 200 }),
    );
    const fetcher = new RobotsAwarePageFetcher(impl);
    await fetcher.fetchClean("https://f-crawldelay.test/a", token());
    await fetcher.fetchClean("https://f-crawldelay.test/b", token());
    expect(pageStarts).toHaveLength(2);
    expect(pageStarts[1] - pageStarts[0]).toBeGreaterThanOrEqual(1_450);
  });
});
