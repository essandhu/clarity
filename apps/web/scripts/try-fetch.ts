// Increment 3 smoke proof (PLAN.md §7): the full fetcher gate chain plus
// RunBudget against the real network.
//
//   cd apps/web && npx tsx scripts/try-fetch.ts [listing-url]
//
// Four scenarios:
//   1. a real page          -> CleanPage: title + first 500 chars
//   2. a robots-blocked URL -> { kind: 'skip', reason: 'robots_disallowed' }
//   3. a dead domain        -> 'network' after visible retry backoff
//   4. a 1-fetch budget     -> second acquisition refused: 'budget_exhausted'
//                              with ZERO network dispatched
import { systemClock } from "../src/domain/pipeline/clock";
import { createRunBudget } from "../src/domain/pipeline/RunBudget";
import { RobotsAwarePageFetcher } from "../src/providers/fetch/RobotsAwarePageFetcher";

const realUrl = process.argv[2] ?? "https://stripe.com/jobs";
// Google disallows /search for every crawler — a reliable robots-blocked path.
const blockedUrl = "https://www.google.com/search?q=clarity";
const deadUrl = "https://definitely-not-a-real-domain-io2fkq.invalid/careers";

const fetcher = new RobotsAwarePageFetcher();

function show(result: Awaited<ReturnType<typeof fetcher.fetchClean>>): void {
  if (result.kind === "page") {
    console.log(`CleanPage  title: ${result.title}`);
    console.log(`           finalUrl: ${result.finalUrl}`);
    console.log(`           text[0..500]: ${result.text.slice(0, 500).replace(/\n/g, " ")}`);
  } else {
    console.log("FetchSkip ", JSON.stringify(result));
  }
}

async function main(): Promise<void> {
  const budget = createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, systemClock);

  console.log(`\n--- 1. real page: ${realUrl} ---`);
  const token1 = budget.tryAcquire("real page");
  if (!token1) throw new Error("budget refused the very first acquisition");
  show(await fetcher.fetchClean(realUrl, token1));

  console.log(`\n--- 2. robots-blocked: ${blockedUrl} ---`);
  const token2 = budget.tryAcquire("robots-blocked page");
  if (!token2) throw new Error("budget unexpectedly exhausted");
  show(await fetcher.fetchClean(blockedUrl, token2));

  console.log(`\n--- 3. dead domain (watch the retry backoff): ${deadUrl} ---`);
  const token3 = budget.tryAcquire("dead domain");
  if (!token3) throw new Error("budget unexpectedly exhausted");
  const started = Date.now();
  show(await fetcher.fetchClean(deadUrl, token3));
  console.log(`           (took ${Date.now() - started} ms across retry attempts)`);

  console.log("\n--- 4. one-fetch budget: second call refused with zero network ---");
  const tinyBudget = createRunBudget({ maxFetches: 1, deadlineMs: 60_000 }, systemClock);
  const first = tinyBudget.tryAcquire("only fetch");
  if (!first) throw new Error("1-fetch budget refused its single acquisition");
  show(await fetcher.fetchClean(realUrl, first));
  const second = tinyBudget.tryAcquire("over budget");
  if (second !== null) throw new Error("budget over-issued past maxFetches");
  // This is exactly what the enricher does on a null token (increment 6):
  // record the skip, dispatch NOTHING.
  show({ kind: "skip", url: realUrl, reason: "budget_exhausted", detail: "tryAcquire returned null — no network dispatched" });
  console.log(`           fetchesUsed: ${tinyBudget.fetchesUsed()} (still 1)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
