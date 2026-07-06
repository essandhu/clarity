import { describe, expect, it } from "vitest";
import {
  BriefingSectionSchema,
  PipelineEventSchema,
  SECTION_PLAN,
} from "@/shared/schema";
import {
  EMPTY_STREAM_TEXT,
  NOT_FOUND_TEXT,
  synthesizeBriefing,
  type BriefingEvent,
} from "./BriefingSynthesizer";
import { makeEnrichment, makeProfile, pastedRef, scriptedModel, webRef } from "./synthesisTestKit";

// Sparse default coverage: what-they-do and seniority-fit stream (low), the
// other four are none — so exactly TWO scripted streams are consumed.

async function run(opts: {
  model: ReturnType<typeof scriptedModel>;
  enrichment?: ReturnType<typeof makeEnrichment>;
  cancel?: AbortSignal;
}) {
  const events: BriefingEvent[] = [];
  const briefing = await synthesizeBriefing(
    makeProfile(),
    opts.enrichment ?? makeEnrichment(),
    { model: opts.model },
    {
      cancel: opts.cancel ?? new AbortController().signal,
      emit: (event) => events.push(PipelineEventSchema.parse(event) as BriefingEvent),
    },
  );
  return { events, briefing };
}

describe("synthesizeBriefing", () => {
  it("streams sourced sections serially and cans none sections with NO model call", async () => {
    const model = scriptedModel({
      streams: [
        ["Acme ", "builds robots."],
        ["A senior backend role."],
      ],
    });
    const { events, briefing } = await run({ model });

    // The fixed plan, in order, one started+completed pair per section.
    const started = events.filter((e) => e.type === "synthesis.section.started");
    const completed = events.filter((e) => e.type === "synthesis.section.completed");
    expect(started.map((e) => e.sectionId)).toEqual([...SECTION_PLAN]);
    expect(completed.map((e) => e.section.id)).toEqual([...SECTION_PLAN]);

    // Decision 16: zero-source sections never touch the model.
    expect(model.streamCalls).toHaveLength(2);

    // Deltas only ever sit between their OWN section's started/completed
    // (§3 guarantee 4) — replay the whole event list to prove it.
    let open: string | null = null;
    for (const event of events) {
      if (event.type === "synthesis.section.started") open = event.sectionId;
      else if (event.type === "synthesis.delta") expect(event.sectionId).toBe(open);
      else open = null;
    }

    const byId = Object.fromEntries(briefing.sections.map((s) => [s.id, s]));
    expect(byId["what-they-do"].content).toBe("Acme builds robots.");
    expect(byId["what-they-do"].confidence).toBe("low");
    expect(byId["what-they-do"].sources).toEqual([pastedRef]);
    expect(byId["product-area"].content).toBe(NOT_FOUND_TEXT);
    expect(byId["product-area"].sources).toEqual([]);
    for (const section of briefing.sections) {
      expect(BriefingSectionSchema.parse(section)).toEqual(section);
    }
  });

  it("badge-before-tokens: started carries confidence + sources ahead of any delta", async () => {
    const model = scriptedModel({ streams: [["chunk"], ["chunk"]] });
    const { events } = await run({ model });
    const firstStarted = events.findIndex((e) => e.type === "synthesis.section.started");
    const firstDelta = events.findIndex((e) => e.type === "synthesis.delta");
    expect(firstStarted).toBeGreaterThanOrEqual(0);
    expect(firstStarted).toBeLessThan(firstDelta);
    const started = events[firstStarted];
    expect(started).toMatchObject({ confidence: "low", sources: [pastedRef] });
  });

  it("prompts contain only that section's own excerpts, framed as untrusted", async () => {
    const about = {
      ref: webRef("https://acme.dev/about", "About"),
      text: "Founded in 2020 by two roboticists.",
    };
    const model = scriptedModel({ streams: [["a"], ["b"], ["c"], ["d"]] });
    await run({ model, enrichment: makeEnrichment({ tier1: [about] }) });
    // what-they-do + product-area (high: about + listing), team-signals
    // (high: about), seniority-fit (low: listing only).
    expect(model.streamCalls).toHaveLength(4);
    const [whatTheyDo, , teamSignals, seniorityFit] = model.streamCalls;
    expect(whatTheyDo.prompt).toContain(about.ref.url);
    expect(whatTheyDo.prompt).toContain("Founded in 2020");
    expect(whatTheyDo.system).toContain("untrusted content");
    expect(teamSignals.prompt).toContain(about.ref.url);
    expect(seniorityFit.prompt).not.toContain(about.ref.url);
    expect(seniorityFit.prompt).toContain(pastedRef.url);
  });

  it("a whitespace-only stream yields honest schema-valid fallback content", async () => {
    const model = scriptedModel({ streams: [["  ", "\n"], ["fine"]] });
    const { events, briefing } = await run({ model });
    const wtd = briefing.sections.find((s) => s.id === "what-they-do");
    expect(wtd?.content).toBe(EMPTY_STREAM_TEXT);
    // Empty chunks are dropped, so the only deltas carry real text.
    const deltas = events.filter((e) => e.type === "synthesis.delta");
    expect(deltas.every((d) => d.text.length > 0)).toBe(true);
  });

  it("an already-aborted cancel emits nothing and returns an empty briefing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const model = scriptedModel({ streams: [] });
    const { events, briefing } = await run({ model, cancel: cancel.signal });
    expect(events).toEqual([]);
    expect(briefing.sections).toEqual([]);
    expect(model.streamCalls).toHaveLength(0);
  });

  it("cancel between sections stops before the next started frame", async () => {
    const cancel = new AbortController();
    const model = scriptedModel({ streams: [["first section text"]] });
    const wrapped = {
      ...model,
      streamSynthesis: (prompt: Parameters<typeof model.streamSynthesis>[0]) => {
        const inner = model.streamSynthesis(prompt);
        return (async function* () {
          yield* inner;
          cancel.abort(); // fires after the first stream finishes cleanly
        })();
      },
    };
    const events: BriefingEvent[] = [];
    const briefing = await synthesizeBriefing(makeProfile(), makeEnrichment(), { model: wrapped }, {
      cancel: cancel.signal,
      emit: (event) => events.push(PipelineEventSchema.parse(event) as BriefingEvent),
    });
    // what-they-do completed; product-area..recent-launches never started.
    expect(briefing.sections.map((s) => s.id)).toEqual(["what-they-do"]);
    expect(events.at(-1)).toMatchObject({
      type: "synthesis.section.completed",
      section: { id: "what-they-do" },
    });
  });
});
