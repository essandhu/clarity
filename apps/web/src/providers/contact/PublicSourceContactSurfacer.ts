import { contactExcerpt, contactPeoplePrompt, promptRef } from "@/domain/contact/contactPrompt";
import { inferEmailPatterns } from "@/domain/contact/emailPattern";
import { urlKey } from "@/domain/enrichment/candidateUrls";
import { isPipelineError } from "@/domain/pipeline/errors";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
import type { SectionExcerpt } from "@/domain/synthesis/sectionSources";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import {
  pageSourceRef,
  type CleanPage,
  type ContactCandidate,
  type ContactSourceTried,
  type FetchSkip,
  type ListingProfile,
  type SourceRef,
} from "@/shared/schema";
import {
  groundPeople,
  isPublicFinalPage,
  linkedInSearchUrl,
  listingCandidate,
  pickCareersRef,
  PeopleSchema,
  type NamedPerson,
} from "./contactCandidates";
import type { ContactCoverage, ContactSource } from "./ContactSource";
import { findGithubContact, isEngineeringRole } from "./githubSignal";

// The one v1 ContactSource (spec §6): publicly listed contacts from the
// listing and careers page, the GitHub org signal, and clearly-labeled
// guesses (inferred email patterns, LinkedIn as the right channel). The
// find() signature stays §4.3-verbatim — budget, cancel and the per-channel
// sourcesTried sink arrive via constructor deps (the StepEmit pattern).
// The listing is NEVER fetched here: listing-derived material uses
// profile.rawText, so 'listing:pasted' cannot reach the fetcher. Pure
// helpers live in contactCandidates.ts (pre-split, ~200-line ceiling).

export interface PublicSourceDeps {
  model: ModelProvider;
  fetcher: PageFetcher;
  budget: RunBudget;
  cancel: AbortSignal;
  /** Per-channel honesty for the response's sourcesTried (§3 siblings). */
  onTried?: (tried: ContactSourceTried) => void;
}

export class PublicSourceContactSurfacer implements ContactSource {
  readonly id = "public-sources";

  constructor(private readonly deps: PublicSourceDeps) {}

  async find(profile: ListingProfile, coverage: ContactCoverage): Promise<ContactCandidate[]> {
    const tried = (entry: ContactSourceTried) => this.deps.onTried?.(entry);
    const candidates: ContactCandidate[] = [];
    const listingRef = coverage.tiers.find((tier) => tier.tier === 0)?.sources[0];

    // (1) The listing's own published contact — already extracted, zero cost.
    const fromListing = listingRef
      ? listingCandidate(profile.applicationContact, profile.rawText, listingRef)
      : undefined;
    if (fromListing) {
      candidates.push(fromListing);
      tried({ id: "listing", status: "found" });
    } else {
      tried({ id: "listing", status: "none" });
    }

    // (2) Careers page re-read through the budgeted fetcher.
    const careersRef = pickCareersRef(coverage);
    let careersPage: CleanPage | undefined;
    let careersSkip: FetchSkip | undefined;
    if (careersRef) {
      const outcome = await this.fetchCareers(careersRef);
      if (outcome.kind === "page") careersPage = outcome;
      else careersSkip = outcome;
    }

    // (3) Named people from the listing text + careers page (one extract).
    const people = await this.extractPeople(profile, listingRef, careersPage);
    const careersKey = careersPage ? urlKey(careersPage.finalUrl) : undefined;
    let careersFound = false;
    for (const person of people) {
      const fromCareers = careersKey !== undefined && urlKey(person.ref.url) === careersKey;
      careersFound = careersFound || fromCareers;
      candidates.push(...personCandidates(person, fromCareers, profile));
    }
    tried(
      careersSkip
        ? { id: "careers", status: "skipped", skip: careersSkip }
        : { id: "careers", status: careersFound ? "found" : "none" },
    );

    // (4) GitHub org signal, engineering roles only (org-page-only scope).
    if (isEngineeringRole(profile)) {
      const github = await findGithubContact(profile, coverage, {
        fetcher: this.deps.fetcher,
        budget: this.deps.budget,
      });
      if (github.candidate) candidates.push(github.candidate);
      tried(github.tried);
    }
    return candidates;
  }

  private async fetchCareers(ref: SourceRef): Promise<CleanPage | FetchSkip> {
    const token = this.deps.budget.tryAcquire("careers page for contacts");
    if (token === null) return { kind: "skip", url: ref.url, reason: "budget_exhausted" };
    const outcome = await this.deps.fetcher.fetchClean(ref.url, token);
    if (outcome.kind === "page" && !isPublicFinalPage(outcome.finalUrl)) {
      return {
        kind: "skip",
        url: ref.url,
        reason: "empty_content",
        detail: `redirected to a non-public host (${outcome.finalUrl}) — content not used`,
      };
    }
    return outcome;
  }

  private async extractPeople(
    profile: ListingProfile,
    listingRef: SourceRef | undefined,
    careersPage: CleanPage | undefined,
  ): Promise<NamedPerson[]> {
    // promptRef clips client-supplied label/url once, BEFORE both the prompt
    // and the grounding map see the ref — they must agree byte-for-byte.
    const excerpts: SectionExcerpt[] = [];
    if (listingRef) {
      excerpts.push({ ref: promptRef(listingRef), text: contactExcerpt(profile.rawText) });
    }
    if (careersPage) {
      excerpts.push({ ref: pageSourceRef(careersPage), text: contactExcerpt(careersPage.text) });
    }
    if (excerpts.length === 0) return [];
    const { system, prompt } = contactPeoplePrompt({
      company: profile.company,
      role: profile.role,
      excerpts,
    });
    try {
      const extracted = await this.deps.model.extract(prompt, PeopleSchema, {
        system,
        abortSignal: this.deps.cancel,
      });
      return groundPeople(extracted.people, excerpts);
    } catch (err) {
      // No named people is a degraded outcome, not a dead contact search —
      // aborts and the watchdog's INTERNAL stall still rethrow (the
      // HookSynthesizer rule applied to Stage 4).
      if (isPipelineError(err) && err.code === "EXTRACTION_FAILED") return [];
      throw err;
    }
  }
}

/** One named person fans out into: a public email candidate (only when the
 *  sources published one — groundPeople keeps `email` only when it literally
 *  appears in the excerpt text), the LinkedIn right-channel guess, and — only
 *  when there is no real email to use — an inferred-pattern guess. */
function personCandidates(
  person: NamedPerson,
  fromCareers: boolean,
  profile: ListingProfile,
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const email = person.email;
  if (email) {
    out.push({
      channel: fromCareers ? "careers" : "listing",
      confidence: "public",
      name: person.name,
      role: person.role,
      value: email,
      source: person.ref,
    });
  }
  out.push({
    channel: "linkedin",
    confidence: "guess",
    name: person.name,
    role: person.role,
    value: linkedInSearchUrl(person.name, profile.company),
    source: person.ref,
  });
  if (!email && profile.domain) {
    const guess = inferEmailPatterns(person.name, profile.domain)[0];
    if (guess) {
      out.push({
        channel: "inferred-email",
        confidence: "guess",
        name: person.name,
        role: person.role,
        value: guess.value,
        source: person.ref,
      });
    }
  }
  return out;
}
