import { describe, expect, it } from "vitest";
import { PipelineEventSchema, type PipelineEvent } from "./events";
import { pastedListingRef } from "./sourceRef";

const ref = {
  url: "https://acme.dev",
  label: "Homepage — Acme",
  fetchedAt: "2026-07-03T12:00:00Z",
};
const pastedRef = pastedListingRef("2026-07-03T12:00:00Z");

// One hand-written fixture per event type — every member of the union.
const fixtures: PipelineEvent[] = [
  {
    type: "run.started",
    runId: "run_1",
    provider: { id: "ollama" },
    budget: { maxFetches: 12, deadlineMs: 60_000 },
    input: { kind: "text" },
  },
  { type: "heartbeat" },
  { type: "stage.started", stage: "extraction" },
  {
    type: "step.started",
    stepId: "s1",
    stage: "enrichment",
    label: "Reading careers page…",
    url: "https://acme.dev/careers",
    tier: 1,
  },
  {
    type: "step.finished",
    stepId: "s1",
    status: "ok",
    source: ref,
    cached: true,
  },
  {
    type: "extraction.completed",
    profile: {
      company: "Acme Robotics",
      role: "Senior Backend Engineer",
      namedTechnologies: [],
      rawText: "Acme Robotics is hiring…",
    },
  },
  {
    type: "enrichment.tier.completed",
    tier: 0,
    status: "found",
    sources: [pastedRef],
  },
  {
    type: "budget.exhausted",
    kind: "fetches",
    fetchesUsed: 12,
    elapsedMs: 41_000,
    skippedTiers: [3],
  },
  {
    type: "enrichment.completed",
    summary: {
      tiers: [{ tier: 1, status: "found", sourceCount: 2 }],
      fetchesUsed: 7,
    },
  },
  {
    type: "synthesis.section.started",
    sectionId: "what-they-do",
    title: "What they do",
    confidence: "high",
    sources: [ref],
  },
  { type: "synthesis.delta", sectionId: "what-they-do", text: "Acme builds " },
  {
    type: "synthesis.section.completed",
    section: {
      id: "recent-launches",
      title: "Recent launches",
      content: "Not found in available sources.",
      confidence: "none",
      sources: [],
    },
  },
  {
    type: "synthesis.hooks.completed",
    hooks: [
      {
        text: "Their changelog shipped SSO last month",
        basis: "changelog entry dated June 2026",
        confidence: "high",
        sources: [ref],
      },
    ],
  },
  { type: "run.completed", runId: "run_1", elapsedMs: 38_000, fetchCount: 7 },
  {
    type: "run.error",
    code: "MODEL_UNCONFIGURED",
    message: "No model provider is configured.",
    hint: "Set ANTHROPIC_API_KEY, or run Ollama and set MODEL_PROVIDER=ollama",
  },
  { type: "draft.started" },
  { type: "draft.delta", text: "Hi Sam — " },
  {
    type: "draft.completed",
    note: { body: "Hi Sam — …", groundedHooks: ["Their changelog shipped SSO last month"] },
  },
  { type: "profile.import.started" },
  {
    type: "profile.import.completed",
    entries: {
      experience: [
        {
          id: "e1",
          org: "Driftlock",
          role: "Senior Software Engineer",
          startDate: "Jan 2022",
          bullets: [{ id: "b1", text: "Rebuilt the event ingestion pipeline in Go" }],
          provenance: { origin: "pasted-resume", importedAt: "2026-07-12T00:00:00.000Z" },
        },
      ],
      projects: [],
      education: [],
      skills: [{ id: "s1", category: "Languages", items: ["Go", "TypeScript"] }],
    },
    report: {
      droppedStrings: [
        { path: "experience[0].bullets[1]", text: "Led a 40% revenue increase", reason: "not-verbatim" },
      ],
      truncated: false,
      notes: [],
    },
  },
  { type: "tailor.started" },
  {
    type: "tailor.role.completed",
    profile: {
      company: "Tessellate",
      role: "Platform Engineer",
      namedTechnologies: ["Go"],
      rawText: "Tessellate is hiring a Platform Engineer…",
    },
  },
  {
    type: "tailor.completed",
    resume: {
      roleLabel: "Platform Engineer at Tessellate",
      identity: { name: "Maya Chen", links: [] },
      entries: [
        {
          entryId: "e1",
          kind: "experience",
          heading: "Driftlock",
          subheading: "Senior Software Engineer",
          dates: "Jan 2022 -- Present",
          bullets: [
            {
              bulletId: "b1",
              text: "Led the migration of 14 services",
              disposition: "reverted",
              offendingTokens: ["kubernetes"],
            },
          ],
        },
      ],
      education: [],
      skills: [{ id: "s1", category: "Languages", items: ["Go"] }],
    },
    coverage: {
      mode: "tailored",
      entriesTotal: 3,
      entriesOffered: 3,
      entriesSelected: 1,
      bulletsSelected: 1,
      bulletsRephrased: 0,
      bulletsReverted: 1,
      dropped: [{ kind: "skill", reason: "not_subset", count: 1, samples: ["Kubernetes"] }],
      keywords: { matched: ["Go"], missing: ["Kubernetes"] },
    },
  },
];

describe("PipelineEventSchema", () => {
  it.each(fixtures.map((f) => [f.type, f] as const))(
    "round-trips %s",
    (_type, fixture) => {
      expect(PipelineEventSchema.parse(fixture)).toEqual(fixture);
    },
  );

  it("covers every member of the union", () => {
    expect(new Set(fixtures.map((f) => f.type)).size).toBe(
      PipelineEventSchema.options.length,
    );
  });

  it("parses a cancelled step.finished frame with no url — the non-fetch skip", () => {
    const frame = PipelineEventSchema.parse({
      type: "step.finished",
      stepId: "hooks-1",
      status: "skipped",
      skip: { kind: "skip", reason: "cancelled" },
    });
    if (frame.type !== "step.finished") throw new Error("wrong branch");
    expect(frame.skip?.url).toBeUndefined();
  });

  it("rejects an unknown event type", () => {
    expect(
      PipelineEventSchema.safeParse({ type: "run.paused" }).success,
    ).toBe(false);
  });

  it("rejects more than 3 hooks on the wire", () => {
    const hook = {
      text: "t",
      basis: "b",
      confidence: "high" as const,
      sources: [ref],
    };
    expect(
      PipelineEventSchema.safeParse({
        type: "synthesis.hooks.completed",
        hooks: [hook, hook, hook, hook],
      }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range tier", () => {
    expect(
      PipelineEventSchema.safeParse({
        type: "enrichment.tier.completed",
        tier: 4,
        status: "found",
        sources: [],
      }).success,
    ).toBe(false);
  });
});
