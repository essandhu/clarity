import { describe, expect, it } from "vitest";
import { PipelineError } from "@/domain/pipeline/errors";
import type { StepEvent } from "@/domain/pipeline/steps";
import { HookSchema, PipelineEventSchema } from "@/shared/schema";
import { synthesizeHooks, MAX_HOOKS, STEP_HOOKS } from "./HookSynthesizer";
import { makeEnrichment, makeProfile, pastedRef, scriptedModel, webRef } from "./synthesisTestKit";

const blogRef = webRef("https://acme.dev/blog/launch", "Acme launches v2");
const enrichmentWithBlog = () =>
  makeEnrichment({ tier2: [{ ref: blogRef, text: "Acme shipped v2 of its picker in June." }] });

const rawHook = (over: Partial<{ text: string; basis: string; sourceUrls: string[] }> = {}) => ({
  text: "Congrats on shipping v2 of the picker.",
  basis: "The blog announced the v2 launch, relevant to the ingestion role.",
  sourceUrls: [blogRef.url],
  ...over,
});

async function run(opts: {
  extractions: unknown[];
  enrichment?: ReturnType<typeof makeEnrichment>;
  cancel?: AbortSignal;
}) {
  const model = scriptedModel({ extractions: opts.extractions });
  const steps: StepEvent[] = [];
  const hooks = await synthesizeHooks(
    makeProfile(),
    opts.enrichment ?? enrichmentWithBlog(),
    { model },
    {
      cancel: opts.cancel ?? new AbortController().signal,
      onStep: (event) => steps.push(PipelineEventSchema.parse(event) as StepEvent),
    },
  );
  return { hooks, steps, model };
}

describe("synthesizeHooks — grounding (decision 18)", () => {
  it("drops a hook citing an unfetched URL; one citing listing:pasted survives", async () => {
    const { hooks } = await run({
      extractions: [
        {
          hooks: [
            rawHook({ text: "Fabricated", sourceUrls: ["https://never-fetched.example/post"] }),
            rawHook({ text: "Listing-grounded", basis: "Stated in the listing.", sourceUrls: [pastedRef.url] }),
          ],
        },
      ],
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      text: "Listing-grounded",
      confidence: "low",
      sources: [pastedRef],
    });
    expect(HookSchema.parse(hooks[0])).toEqual(hooks[0]);
  });

  it("keeps web-grounded hooks as high and maps cited URLs back to real refs", async () => {
    const { hooks } = await run({ extractions: [{ hooks: [rawHook()] }] });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].confidence).toBe("high");
    expect(hooks[0].sources).toEqual([blogRef]);
  });

  it("normalizes citation URLs through urlKey (trailing slash, fragment)", async () => {
    const { hooks } = await run({
      extractions: [
        { hooks: [rawHook({ sourceUrls: [`${blogRef.url}/#launch`] })] },
      ],
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].sources).toEqual([blogRef]);
  });

  it("a hook citing a fabricated URL alongside a real one keeps only the real ref", async () => {
    const { hooks } = await run({
      extractions: [
        { hooks: [rawHook({ sourceUrls: ["https://evil.example/", blogRef.url, blogRef.url] })] },
      ],
    });
    expect(hooks[0].sources).toEqual([blogRef]);
  });

  it("caps surviving hooks at MAX_HOOKS and dedupes identical texts", async () => {
    const many = [1, 2, 3, 4, 5].map((n) => rawHook({ text: `Hook number ${n}` }));
    const { hooks } = await run({
      extractions: [{ hooks: [rawHook(), rawHook(), ...many] }],
    });
    expect(hooks.length).toBe(MAX_HOOKS);
    expect(new Set(hooks.map((h) => h.text)).size).toBe(MAX_HOOKS);
  });

  it("drops hooks whose text or basis trims to empty", async () => {
    const { hooks } = await run({
      extractions: [{ hooks: [rawHook({ text: "  " }), rawHook({ basis: " \n" })] }],
    });
    expect(hooks).toEqual([]);
  });

  it("an ALL-dropped batch is visible: honest skip naming the drop, never a clean check", async () => {
    // PLAN.md §4 / decision 18: fabrications are traceable. Three hooks, all
    // citing never-fetched URLs — the step must not read as a plain success.
    const { hooks, steps } = await run({
      extractions: [
        {
          hooks: [1, 2, 3].map((n) =>
            rawHook({ text: `Fabricated ${n}`, sourceUrls: [`https://fake${n}.example/post`] }),
          ),
        },
      ],
    });
    expect(hooks).toEqual([]);
    expect(steps[1]).toMatchObject({
      status: "skipped",
      skip: {
        reason: "empty_content",
        detail: expect.stringContaining("none cited a fetched source"),
      },
    });
  });

  it("a model that proposes NO hooks finishes ok — an empty answer is a success", async () => {
    const { steps } = await run({ extractions: [{ hooks: [] }] });
    expect(steps[1]).toMatchObject({ status: "ok" });
  });
});

describe("synthesizeHooks — step pair + failure modes", () => {
  it("covers the extract with a visible step pair (§8: never dark)", async () => {
    const { steps, model } = await run({ extractions: [{ hooks: [] }] });
    expect(steps.map((s) => s.type)).toEqual(["step.started", "step.finished"]);
    expect(steps[0]).toMatchObject({
      stepId: STEP_HOOKS,
      stage: "synthesis",
      label: "Finding outreach hooks…",
    });
    expect(steps[1]).toMatchObject({ stepId: STEP_HOOKS, status: "ok" });
    // The prompt embeds the numbered sources with their exact URLs.
    expect(model.extractCalls[0].input).toContain(`Source URL: ${blogRef.url}`);
    expect(model.extractCalls[0].input).toContain(`Source URL: ${pastedRef.url}`);
    expect(model.extractCalls[0].opts?.system).toContain("untrusted content");
  });

  it("EXTRACTION_FAILED degrades to zero hooks with an honest skip, never a throw", async () => {
    const failure = new PipelineError("EXTRACTION_FAILED", "no valid JSON after repair");
    const { hooks, steps } = await run({ extractions: [failure] });
    expect(hooks).toEqual([]);
    expect(steps[1]).toMatchObject({
      status: "skipped",
      skip: { reason: "empty_content", detail: expect.stringContaining("could not produce") },
    });
  });

  it("a watchdog stall (INTERNAL) rethrows and leaves the step open for pipeline pairing", async () => {
    const stall = new PipelineError("INTERNAL", "Model call made no progress and was aborted.");
    const steps: StepEvent[] = [];
    await expect(
      synthesizeHooks(makeProfile(), enrichmentWithBlog(), { model: scriptedModel({ extractions: [stall] }) }, {
        cancel: new AbortController().signal,
        onStep: (event) => steps.push(event),
      }),
    ).rejects.toBe(stall);
    expect(steps.map((s) => s.type)).toEqual(["step.started"]);
  });

  it("an abort rethrows untouched (the pipeline's silent-return owns it)", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      synthesizeHooks(makeProfile(), enrichmentWithBlog(), { model: scriptedModel({ extractions: [abort] }) }, {
        cancel: new AbortController().signal,
        onStep: () => {},
      }),
    ).rejects.toBe(abort);
  });
});
