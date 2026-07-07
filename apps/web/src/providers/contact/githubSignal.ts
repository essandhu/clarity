import { firstEmail } from "@/domain/contact/emailPattern";
import { githubOrgUrl, looseNameMatch } from "@/domain/enrichment/linkDiscovery";
import { peekCached } from "@/domain/pipeline/cachePeek";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import {
  pageSourceRef,
  type CleanPage,
  type ContactCandidate,
  type ContactSourceTried,
  type FetchSkip,
  type ListingProfile,
  type SourceRef,
} from "@/shared/schema";
import type { ContactCoverage } from "./ContactSource";

// The public GitHub signal (spec §6.2, PLAN.md §4 Stage 4 candidate 3):
// engineering roles only, org-page-ONLY scope — no commit-email harvesting
// (§7) — fetched through the same robots-aware PageFetcher, and counted only
// on a loose company-name match (the wrong-org rule, decision 20). Contact
// never guesses fresh org slugs: it re-reads only an org page the run itself
// already surfaced, NORMALIZED to the owner page (coverage is client-supplied
// — a repo/commit path must not widen the scope).

// Role titles only: the generic tokens (bare "data", "security") and the
// namedTechnologies catch-all admitted "Data Entry Clerk" and any listing
// naming a SaaS tool (review finding) — under-trying GitHub is the safe
// direction for a channel scoped to engineering roles.
const ENGINEERING_ROLE =
  /\b(engineer(ing)?|developer|swe|sre|devops|architect|programmer|software|platform|infrastructure|backend|front-?end|full-?stack|mobile|ios|android|data scientist|machine learning)\b/i;

export function isEngineeringRole(profile: ListingProfile): boolean {
  return ENGINEERING_ROLE.test(profile.role);
}

/** The GitHub org page the run already cited, if any — normalized to the
 *  OWNER page via the same rule tier-2 discovery uses, so a client-supplied
 *  repo/commit path can never widen the org-page-only scope. */
export function githubOrgRef(coverage: ContactCoverage): SourceRef | undefined {
  for (const tier of coverage.tiers) {
    for (const ref of tier.sources) {
      try {
        const url = new URL(ref.url);
        if (!/^https?:$/.test(url.protocol)) continue;
        if (url.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") continue;
        const orgUrl = githubOrgUrl(url);
        if (orgUrl) return { ...ref, url: orgUrl };
      } catch {
        // The pasted-listing sentinel (and any malformed ref) is not a URL.
      }
    }
  }
  return undefined;
}

const GITHUB_FINAL_HOST = /^(www\.)?github\.com$/i;

export interface GithubSignalDeps {
  fetcher: PageFetcher;
  budget: RunBudget;
}

export async function findGithubContact(
  profile: ListingProfile,
  coverage: ContactCoverage,
  deps: GithubSignalDeps,
): Promise<{ candidate?: ContactCandidate; tried: ContactSourceTried }> {
  const orgRef = githubOrgRef(coverage);
  if (!orgRef) return { tried: { id: "github", status: "none" } };
  // Cache peek before acquisition (increment 9): the run fetched this org
  // page minutes ago, so the re-read is normally free. Every guard below
  // (final host, name match) applies to a cached page identically.
  const cached = await peekCached(deps.fetcher, orgRef.url, deps.budget.deadlineSignal);
  let outcome: CleanPage | FetchSkip;
  if (cached) {
    outcome = cached;
  } else {
    const token = deps.budget.tryAcquire("github org page");
    if (token === null) {
      return {
        tried: {
          id: "github",
          status: "skipped",
          skip: { kind: "skip", url: orgRef.url, reason: "budget_exhausted" },
        },
      };
    }
    outcome = await deps.fetcher.fetchClean(orgRef.url, token);
  }
  if (outcome.kind === "skip") {
    return { tried: { id: "github", status: "skipped", skip: outcome } };
  }
  // A redirect off github.com leaves the org-page-only scope (review finding
  // — final host, not just the dialed host, decides).
  let finalHost = "";
  try {
    finalHost = new URL(outcome.finalUrl).hostname;
  } catch {
    // finalHost stays "" and the guard below refuses it.
  }
  if (!GITHUB_FINAL_HOST.test(finalHost)) {
    return {
      tried: {
        id: "github",
        status: "skipped",
        skip: {
          kind: "skip",
          url: orgRef.url,
          reason: "empty_content",
          detail: `redirected off github.com (${outcome.finalUrl}) — content not used`,
        },
      },
    };
  }
  // The org page must still read as this company's (a rename/transfer since
  // the run is possible), and only an email the page PUBLISHES counts —
  // nothing is inferred here.
  if (!looseNameMatch(profile.company, outcome)) {
    return { tried: { id: "github", status: "none" } };
  }
  const email = firstEmail(outcome.text);
  if (!email) return { tried: { id: "github", status: "none" } };
  return {
    candidate: {
      channel: "github",
      confidence: "public",
      value: email,
      source: pageSourceRef(outcome),
    },
    tried: { id: "github", status: "found" },
  };
}
