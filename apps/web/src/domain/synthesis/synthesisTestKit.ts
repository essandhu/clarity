import type { ZodType } from "zod";
import type { GenOpts, ModelProvider, SynthesisPrompt } from "@/providers/model/ModelProvider";
import {
  pastedListingRef,
  type EnrichmentResult,
  type ListingProfile,
  type SourceRef,
  type TierCoverage,
  type TierNumber,
} from "@/shared/schema";

// Shared harness for the synthesis test files (split by module under the
// ~200-line ceiling). Typed against the sanctioned ModelProvider interface
// only — the eslint layering rule bans provider implementations (incl.
// FakeModelProvider) from src/domain/**, so the stream-capable stub lives
// here, like extractorTestKit's stubModel.

export const SUBMITTED_AT = "2026-07-05T12:00:00.000Z";
export const pastedRef = pastedListingRef(SUBMITTED_AT);

export function makeProfile(overrides: Partial<ListingProfile> = {}): ListingProfile {
  return {
    company: "Acme Robotics",
    role: "Backend Engineer",
    namedTechnologies: [],
    rawText: "Acme Robotics is hiring a backend engineer to own ingestion.",
    ...overrides,
  };
}

export function webRef(url: string, label?: string): SourceRef {
  return { url, label: label ?? url, fetchedAt: "2026-07-05T12:00:01.000Z" };
}

export interface TierSource {
  ref: SourceRef;
  text: string;
}

export function makeTier(tier: TierNumber, sources: TierSource[]): TierCoverage {
  return {
    tier,
    status: sources.length > 0 ? "found" : "not_found",
    sources: sources.map((source) => source.ref),
    extracted: Object.fromEntries(sources.map((source) => [source.ref.url, source.text])),
  };
}

/** Tier 0 defaults to the pasted listing carrying the default profile text. */
export function makeEnrichment(
  opts: {
    listing?: TierSource;
    tier1?: TierSource[];
    tier2?: TierSource[];
    tier3?: TierSource[];
    fetchesUsed?: number;
  } = {},
): EnrichmentResult {
  const listing = opts.listing ?? { ref: pastedRef, text: makeProfile().rawText };
  return {
    tiers: [
      makeTier(0, [listing]),
      makeTier(1, opts.tier1 ?? []),
      makeTier(2, opts.tier2 ?? []),
      makeTier(3, opts.tier3 ?? []),
    ],
    fetchesUsed: opts.fetchesUsed ?? 0,
  };
}

/** Scripted extract results (Error entries throw) + scripted stream chunk
 *  arrays, consumed in call order; every call is recorded. */
export function scriptedModel(
  script: { extractions?: unknown[]; streams?: string[][] } = {},
): ModelProvider & {
  extractCalls: { input: string; opts?: GenOpts }[];
  streamCalls: SynthesisPrompt[];
} {
  const extractions = [...(script.extractions ?? [])];
  const streams = [...(script.streams ?? [])];
  const extractCalls: { input: string; opts?: GenOpts }[] = [];
  const streamCalls: SynthesisPrompt[] = [];
  return {
    id: "scripted",
    extractCalls,
    streamCalls,
    async extract<T>(input: string, schema: ZodType<T>, opts?: GenOpts): Promise<T> {
      extractCalls.push({ input, opts });
      opts?.abortSignal?.throwIfAborted();
      const next = extractions.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("scriptedModel: no scripted extraction left");
      return schema.parse(next);
    },
    async *streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string> {
      streamCalls.push(prompt);
      const chunks = streams.shift();
      if (chunks === undefined) throw new Error("scriptedModel: no scripted stream left");
      for (const chunk of chunks) {
        prompt.abortSignal?.throwIfAborted();
        yield chunk;
      }
    },
  };
}
