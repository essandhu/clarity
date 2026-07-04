import robotsParser from "robots-parser";
import { BrokenCircuitError } from "cockatiel";
import type { FetchSkip } from "@/shared/schema";
import { runFetchAttempts } from "./resilience";
import { discardBody, MAX_ROBOTS_BYTES, readBodyTruncated } from "./readBody";

// Gate 1 of the fetcher chain (PLAN.md decision 12): robots.txt is fetched
// once per origin per process, cached as an in-flight promise on globalThis
// (survives Next dev-mode HMR, and parallel same-origin fetches share one
// lookup). The lookup runs through the same per-origin resilience policy as
// page fetches (retry with backoff; failures feed the origin's breaker).
// Verdicts: parseable rules ⇒ ask the parser; 4xx ⇒ allow (RFC 9309
// §2.3.1.3 — the plan names 404, the RFC extends to the 400 class); 5xx or
// timeout ⇒ the host is alive but permission is unverifiable ⇒ conservative
// robots_disallowed skip; a network-dead host ⇒ honest `network` skip (the
// page fetch would fail identically — a dead domain is not a robots verdict).
// Unreachable records are evicted so a later run may retry. robots.txt
// lookups are amortized inside this unit and never consume the fetch budget.

export const USER_AGENT =
  "ClarityBot/0.1 (+https://github.com/essandhu/clarity; local job-research tool)";
// Product token for robots group matching — robots-parser strips versions and
// lowercases, but the full UA string (with the +url part) is not a group name.
export const ROBOTS_UA = "ClarityBot";
export const ROBOTS_TIMEOUT_MS = 5_000;
// A hostile robots.txt can demand enormous Crawl-delays; cap what we honor.
export const MAX_CRAWL_DELAY_MS = 10_000;

export type FetchLike = typeof fetch;

type RobotsRecord =
  | { kind: "rules"; robot: ReturnType<typeof robotsParser> }
  | { kind: "allow-all" }
  | { kind: "unreachable"; reason: FetchSkip["reason"]; detail: string };

const CACHE_KEY = Symbol.for("clarity.fetch.robotsCache");
const store = globalThis as { [CACHE_KEY]?: Map<string, Promise<RobotsRecord>> };

const describeError = (err: unknown): string =>
  err instanceof Error
    ? [err.message, err.cause instanceof Error ? err.cause.message : null].filter(Boolean).join(": ")
    : String(err);

async function loadRobots(
  origin: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<RobotsRecord> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    // The body is read INSIDE the attempt: the whole thing is bounded by the
    // per-attempt timeout, and cockatiel aborts the attempt signal the moment
    // the attempt returns (abortOnReturn defaults on) — a Response read after
    // that point would find its body stream cancelled. Oversized robots files
    // are truncated at MAX_ROBOTS_BYTES, per RFC 9309 §2.4.
    const res = await runFetchAttempts({
      origin,
      attemptTimeoutMs: ROBOTS_TIMEOUT_MS,
      outerSignal: signal,
      attempt: async (attemptSignal) => {
        const response = await fetchImpl(robotsUrl, {
          signal: attemptSignal,
          redirect: "follow",
          headers: { "user-agent": USER_AGENT },
        });
        if (!response.ok) {
          discardBody(response);
          return { ok: false as const, status: response.status, body: "" };
        }
        return {
          ok: true as const,
          status: response.status,
          body: await readBodyTruncated(response, MAX_ROBOTS_BYTES),
        };
      },
    });
    if (res.ok) {
      return { kind: "rules", robot: robotsParser(robotsUrl, res.body) };
    }
    if (res.status >= 400 && res.status < 500) {
      return { kind: "allow-all" };
    }
    return {
      kind: "unreachable",
      reason: "robots_disallowed",
      detail: `couldn't verify robots.txt — skipped conservatively (HTTP ${res.status})`,
    };
  } catch (err) {
    if (err instanceof BrokenCircuitError) {
      return {
        kind: "unreachable",
        reason: "circuit_open",
        detail: "circuit open for this origin — robots.txt not retried",
      };
    }
    if (err instanceof TypeError) {
      // undici network failures (DNS, refused, reset, TLS): the host itself
      // is unreachable — the honest verdict is `network`, not a robots one.
      return {
        kind: "unreachable",
        reason: "network",
        detail: `robots.txt fetch failed — host unreachable (${describeError(err)})`,
      };
    }
    return {
      kind: "unreachable",
      reason: "robots_disallowed",
      detail: `couldn't verify robots.txt — skipped conservatively (${describeError(err)})`,
    };
  }
}

export interface RobotsVerdict {
  /** Set ⇒ do not fetch; the skip is the caller's return value. */
  skip?: FetchSkip;
  /** Crawl-delay for this host in ms (capped), when the rules specify one. */
  crawlDelayMs?: number;
}

export async function robotsGate(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<RobotsVerdict> {
  const origin = new URL(url).origin;
  const cache = (store[CACHE_KEY] ??= new Map());
  let pending = cache.get(origin);
  if (!pending) {
    pending = loadRobots(origin, signal, fetchImpl);
    cache.set(origin, pending);
  }
  const record = await pending;

  if (record.kind === "unreachable") {
    // Do not poison the origin for the whole process over a transient
    // failure — evict so the next call retries. (If OUR signal caused the
    // shared lookup to abort, this is a cancellation, not a robots verdict.
    // Accepted race: a caller from a DIFFERENT run sharing this in-flight
    // lookup can inherit the starter's abort as one conservative skip; the
    // eviction below self-heals it on that run's next same-origin fetch.)
    cache.delete(origin);
    if (signal.aborted) {
      return { skip: { kind: "skip", url, reason: "cancelled", detail: "aborted during robots.txt check" } };
    }
    return { skip: { kind: "skip", url, reason: record.reason, detail: record.detail } };
  }

  if (record.kind === "allow-all") return {};

  // Same-origin by construction, so undefined (the cross-origin footgun)
  // can only mean "no applicable rule" here — treat as allowed (decision 12:
  // `!== false` after same-origin check). Never use isDisallowed(): it
  // returns true for undefined.
  if (record.robot.isAllowed(url, ROBOTS_UA) === false) {
    return {
      skip: {
        kind: "skip",
        url,
        reason: "robots_disallowed",
        detail: `disallowed for ${ROBOTS_UA} by robots.txt`,
      },
    };
  }

  // robots-parser returns Crawl-delay in raw robots.txt SECONDS.
  const delaySeconds = record.robot.getCrawlDelay(ROBOTS_UA);
  const crawlDelayMs =
    delaySeconds !== undefined && Number.isFinite(delaySeconds) && delaySeconds > 0
      ? Math.min(MAX_CRAWL_DELAY_MS, Math.round(delaySeconds * 1000))
      : undefined;
  return crawlDelayMs === undefined ? {} : { crawlDelayMs };
}
