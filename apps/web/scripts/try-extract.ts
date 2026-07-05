// Increment 4 smoke proof (PLAN.md §7): Stage 1 end-to-end.
//
//   cd apps/web && npx tsx scripts/try-extract.ts fixtures/listings/sparse-startup.txt
//   cd apps/web && npx tsx scripts/try-extract.ts --url <live listing url>
//
// Both paths must print a zod-valid ListingProfile. The text path must carry
// the canonical listing:pasted Tier-0 ref; a URL path on an ATS host
// (greenhouse etc.) must NOT surface that host as the company domain — the
// script exits 1 if either §7 assertion fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractListing } from "../src/domain/listing/ListingExtractor";
import { isPipelineError } from "../src/domain/pipeline/errors";
import { systemClock } from "../src/domain/pipeline/clock";
import { createRunBudget } from "../src/domain/pipeline/RunBudget";
import { RobotsAwarePageFetcher } from "../src/providers/fetch/RobotsAwarePageFetcher";
import { createModelProvider } from "../src/providers/model/createModelProvider";
import {
  AnalyzeInputSchema,
  ListingProfileSchema,
  PASTED_LISTING_URL,
  type AnalyzeInput,
} from "../src/shared/schema";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // No .env.local — plain process.env still works.
}

// Independent of domainDeriver's real denylist on purpose: if that list ever
// regressed, this assertion must still catch a greenhouse.io domain.
const ATS_SUFFIXES = ["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com"];

function parseArgs(): AnalyzeInput {
  const [first, second] = process.argv.slice(2);
  if (first === "--url") {
    if (!second) usage();
    return AnalyzeInputSchema.parse({ kind: "url", url: second });
  }
  if (!first) usage();
  // A bare URL was clearly not meant as a fixture path — accept it.
  if (/^https?:\/\//i.test(first)) {
    return AnalyzeInputSchema.parse({ kind: "url", url: first });
  }
  try {
    return AnalyzeInputSchema.parse({ kind: "text", text: readFileSync(first, "utf8") });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`fixture file not found: ${first}`);
      usage();
    }
    throw err;
  }
}

function usage(): never {
  console.error("usage: npx tsx scripts/try-extract.ts <fixture-path> | --url <listing-url>");
  process.exit(1);
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  const input = parseArgs();
  const provider = createModelProvider();
  console.log(`provider: ${provider.id}`);
  console.log(
    `input: ${input.kind === "url" ? input.url : `${input.text.length} chars of pasted text`}`,
  );

  const budget = createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, systemClock);
  const started = Date.now();
  const { profile, listingSource } = await extractListing(
    input,
    { model: provider, fetcher: new RobotsAwarePageFetcher() },
    { budget, submittedAt: new Date().toISOString() },
  );
  const elapsed = Date.now() - started;

  // Re-assert validity independently of the extractor's own parse.
  ListingProfileSchema.parse(profile);
  const { rawText, ...visible } = profile;
  console.log(`\n--- zod-valid ListingProfile (${elapsed} ms, ${budget.fetchesUsed()} fetch(es)) ---`);
  console.log(JSON.stringify(visible, null, 2));
  console.log(`rawText: ${rawText.length} chars (schema cap 20000)`);
  console.log(`\nTier-0 listing source: ${JSON.stringify(listingSource)}`);

  console.log("\n--- §7 increment-4 checks ---");
  if (input.kind === "text") {
    assert(
      listingSource.url === PASTED_LISTING_URL,
      `text path carries the ${PASTED_LISTING_URL} Tier-0 ref`,
    );
    assert(budget.fetchesUsed() === 0, "text path dispatched zero fetches");
  } else {
    assert(listingSource.url !== PASTED_LISTING_URL, "URL path cites the fetched page");
    assert(budget.fetchesUsed() === 1, "URL path spent exactly one budgeted fetch");
  }
  const domainIsAts =
    profile.domain !== undefined &&
    ATS_SUFFIXES.some((s) => profile.domain === s || profile.domain?.endsWith(`.${s}`));
  assert(!domainIsAts, `domain (${profile.domain ?? "absent"}) is not an ATS host`);
}

main().catch((err: unknown) => {
  if (isPipelineError(err)) {
    console.error(`\n${err.code}: ${err.message}`);
    if (err.hint) console.error(err.hint);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
