import type { CleanPage, FetchSkip } from "@/shared/schema";
import type { BudgetToken } from "@/domain/pipeline/RunBudget";
import type { PageFetcher } from "./PageFetcher";
import { robotsGate, USER_AGENT, type FetchLike } from "./robotsGate";
import { applyCrawlDelay, hostLimiter } from "./hostRateLimiter";
import { errorToSkip, HttpStatusError, NotHtmlError, runFetchAttempts, TooLargeError } from "./resilience";
import { discardBody, MAX_BODY_BYTES, readBodyCapped } from "./readBody";
import { readabilityClean } from "./readabilityClean";

export { MAX_BODY_BYTES };

// Gate order (PLAN.md §4.2): [cache — increment 9] → robots → limiter (inside
// the breaker+retry policy, so retries queue behind the politeness delay
// too; the per-attempt timeout starts inside the queue slot) → content-type/
// size guards → readability/cheerio clean. Every failure mode returns a
// typed FetchSkip; nothing here ever throws into the pipeline (decision 21).

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;

const cancelledSkip = (url: string, signal: AbortSignal): FetchSkip => ({
  kind: "skip",
  url,
  reason: "cancelled",
  detail: signal.reason instanceof Error ? signal.reason.message : "aborted",
});

export class RobotsAwarePageFetcher implements PageFetcher {
  // Injected for tests only; production always uses global fetch.
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchClean(url: string, token: BudgetToken): Promise<CleanPage | FetchSkip> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // No `url` on this skip: FetchSkipSchema requires a real http(s) URL
      // there, and this string is not one — the detail carries it instead.
      return { kind: "skip", reason: "network", detail: `not a fetchable URL: ${url}` };
    }
    // mailto:, javascript:, ftp: etc. parse fine but are not fetchable — and
    // increment 6's link discovery will feed exactly such hrefs in here.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { kind: "skip", reason: "network", detail: `not a fetchable URL: ${url}` };
    }
    if (token.signal.aborted) return cancelledSkip(url, token.signal);

    const verdict = await robotsGate(url, token.signal, this.fetchImpl);
    if (verdict.skip) return verdict.skip;
    if (verdict.crawlDelayMs !== undefined) {
      // A failed politeness raise must never take the fetch down with it.
      await applyCrawlDelay(parsed.host, verdict.crawlDelayMs).catch(() => {});
    }
    if (token.signal.aborted) return cancelledSkip(url, token.signal);

    let raw: { html: string; finalUrl: string };
    try {
      raw = await runFetchAttempts({
        origin: parsed.origin,
        attemptTimeoutMs: token.timeoutMs,
        outerSignal: token.signal,
        queue: (run) => hostLimiter(parsed.host).schedule(run),
        attempt: (signal) => this.attempt(url, signal),
      });
    } catch (err) {
      return errorToSkip(err, url, token.signal);
    }

    // A followed redirect can land on another origin whose robots we never
    // consulted; refuse to USE content a target origin's robots disallows.
    // (The redirect request itself already happened — fetch followed it.)
    let finalOrigin = parsed.origin;
    try {
      finalOrigin = new URL(raw.finalUrl).origin;
    } catch {
      // Unparseable finalUrl: keep the same-origin assumption.
    }
    if (finalOrigin !== parsed.origin) {
      const redirectVerdict = await robotsGate(raw.finalUrl, token.signal, this.fetchImpl);
      if (redirectVerdict.skip) {
        return {
          kind: "skip",
          url,
          reason: redirectVerdict.skip.reason,
          detail: `redirected to ${raw.finalUrl} — ${redirectVerdict.skip.detail ?? redirectVerdict.skip.reason}`,
        };
      }
    }

    // fetchClean never throws (decision 21): even a cleaner crash on
    // pathological HTML must come back as a typed skip.
    let outcome: ReturnType<typeof readabilityClean>;
    try {
      outcome = readabilityClean(raw.html, raw.finalUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { kind: "skip", url, reason: "empty_content", detail: `cleaning failed: ${detail}` };
    }
    if (outcome.kind === "thin") {
      return { kind: "skip", url, reason: "empty_content", detail: outcome.detail };
    }
    return {
      kind: "page",
      url,
      finalUrl: raw.finalUrl,
      title: outcome.title,
      text: outcome.text,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** One bounded attempt: network + status/type/size guards + capped body read. */
  private async attempt(url: string, signal: AbortSignal): Promise<{ html: string; finalUrl: string }> {
    const res = await this.fetchImpl(url, {
      signal,
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });
    if (!res.ok) {
      discardBody(res);
      throw new HttpStatusError(res.status);
    }

    const contentType = res.headers.get("content-type") ?? "";
    // A missing content-type header (misconfigured small-startup server) is
    // given the benefit of the doubt; declared non-HTML types are skipped.
    if (contentType && !HTML_CONTENT_TYPE.test(contentType)) {
      discardBody(res);
      throw new NotHtmlError(contentType);
    }
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      discardBody(res);
      throw new TooLargeError(MAX_BODY_BYTES);
    }

    const html = await readBodyCapped(res, MAX_BODY_BYTES);
    // Test stubs (and exotic servers) can leave Response.url empty.
    return { html, finalUrl: res.url || url };
  }
}
