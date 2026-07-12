import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { PipelineError } from "@/domain/pipeline/errors";
import type { GenOpts, ModelProvider } from "@/providers/model/ModelProvider";
import type { ImportExtraction, PipelineEvent } from "@/shared/schema";
import { runResumeImport, toImportedEntries } from "./ResumeImportPipeline";
import { RESUME_IMPORT_MAX } from "./resumeImportPrompt";

// Interface-typed model stub (the synthesisTestKit precedent — the layering
// rule keeps vendor fakes out of domain tests; this stub is pure interface).

const PASTE = [
  "Maya Chen",
  "Driftlock — Senior Software Engineer   Jan 2020 – Present",
  "- Rebuilt the ingestion pipeline in Go",
  "Skills: Go, TypeScript",
].join("\n");

function stubModel(
  respond: (input: string, opts?: GenOpts) => Promise<unknown>,
): ModelProvider & { calls: { input: string; opts?: GenOpts }[] } {
  const calls: { input: string; opts?: GenOpts }[] = [];
  return {
    id: "stub",
    calls,
    async extract<T>(input: string, _schema: ZodType<T>, opts?: GenOpts): Promise<T> {
      calls.push({ input, opts });
      return (await respond(input, opts)) as T;
    },
    async *streamSynthesis() {
      yield "";
    },
  };
}

function goodExtraction(): ImportExtraction {
  return {
    experience: [
      {
        org: "Driftlock",
        role: "Senior Software Engineer",
        startDate: "Jan 2020",
        bullets: ["Rebuilt the ingestion pipeline in Go"],
      },
    ],
    projects: [],
    education: [],
    skills: [{ category: "Skills", items: ["Go", "TypeScript"] }],
  };
}

function deps(model: ModelProvider) {
  let nextId = 0;
  return {
    getModel: () => model,
    mintId: () => `id-${nextId++}`,
    now: () => "2026-07-12T00:00:00.000Z",
  };
}

async function run(
  model: ModelProvider,
  text = PASTE,
  cancel = new AbortController().signal,
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  await runResumeImport(text, deps(model), (event) => events.push(event), { cancel });
  return events;
}

describe("runResumeImport", () => {
  it("emits started first, then completed with grounded, provenance-stamped entries", async () => {
    const model = stubModel(async () => goodExtraction());
    const events = await run(model);
    expect(events[0]).toEqual({ type: "profile.import.started" });
    const terminal = events.at(-1);
    if (terminal?.type !== "profile.import.completed") throw new Error("no completed frame");
    expect(terminal.entries.experience).toHaveLength(1);
    expect(terminal.entries.experience[0].provenance).toEqual({
      origin: "pasted-resume",
      importedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(terminal.entries.experience[0].id).toMatch(/^id-/);
    expect(terminal.report.droppedStrings).toEqual([]);
    expect(terminal.report.truncated).toBe(false);
  });

  it("requests the stream-backed extract (decision 58) with the fenced prompt", async () => {
    const model = stubModel(async () => goodExtraction());
    await run(model);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].opts?.streamProgress).toBe(true);
    expect(model.calls[0].opts?.temperature).toBe(0);
    expect(model.calls[0].input).toContain("<<<LISTING");
    expect(model.calls[0].input).toContain("Maya Chen");
  });

  it("caps the paste at RESUME_IMPORT_MAX, grounds against the capped slice, and reports truncation", async () => {
    const filler = "Driftlock Senior Software Engineer ".repeat(600); // > 12k chars
    const longText = `${PASTE}\n${filler}`;
    const model = stubModel(async () => goodExtraction());
    const events = await run(model, longText);
    const prompt = model.calls[0].input;
    // The fenced content is the capped slice, not the whole paste.
    expect(prompt.length).toBeLessThan(RESUME_IMPORT_MAX + 500);
    const terminal = events.at(-1);
    if (terminal?.type !== "profile.import.completed") throw new Error("no completed frame");
    expect(terminal.report.truncated).toBe(true);
    expect(terminal.report.notes[0]).toContain("characters were analyzed");
  });

  it("a fabricated string is dropped and named — the gate runs on the pipeline's own output path", async () => {
    const model = stubModel(async () => ({
      ...goodExtraction(),
      skills: [{ category: "Skills", items: ["Go", "Kubernetes"] }],
    }));
    const events = await run(model);
    const terminal = events.at(-1);
    if (terminal?.type !== "profile.import.completed") throw new Error("no completed frame");
    expect(terminal.entries.skills[0].items).toEqual(["Go"]);
    expect(terminal.report.droppedStrings).toContainEqual({
      path: "skills[0].items[1]",
      text: "Kubernetes",
      reason: "not-verbatim",
    });
  });

  it("maps EXTRACTION_FAILED to run.error on the stream — never a throw", async () => {
    const model = stubModel(async () => {
      throw new PipelineError("EXTRACTION_FAILED", "no valid JSON", { hint: "retry" });
    });
    const events = await run(model);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      code: "EXTRACTION_FAILED",
      message: "no valid JSON",
    });
  });

  it("a lazy-getModel failure lands ON the stream as MODEL_UNCONFIGURED", async () => {
    const events: PipelineEvent[] = [];
    await runResumeImport(
      PASTE,
      {
        getModel: () => {
          throw new PipelineError("MODEL_UNCONFIGURED", "no provider");
        },
        mintId: () => "x",
        now: () => "2026-07-12T00:00:00.000Z",
      },
      (event) => events.push(event),
      { cancel: new AbortController().signal },
    );
    expect(events[0]).toEqual({ type: "profile.import.started" });
    expect(events.at(-1)).toMatchObject({ type: "run.error", code: "MODEL_UNCONFIGURED" });
  });

  it("silent-return-on-abort: a cancel mid-extract emits NO terminal frame", async () => {
    const controller = new AbortController();
    const model = stubModel(async (_input, opts) => {
      controller.abort(new Error("user cancelled"));
      throw opts?.abortSignal?.reason ?? new Error("aborted");
    });
    const events = await run(model, PASTE, controller.signal);
    expect(events).toEqual([{ type: "profile.import.started" }]);
  });

  it("a pre-aborted cancel signal stops before any model call", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = stubModel(async () => goodExtraction());
    const events = await run(model, PASTE, controller.signal);
    expect(events).toEqual([{ type: "profile.import.started" }]);
    expect(model.calls).toHaveLength(0);
  });
});

describe("toImportedEntries", () => {
  it("over-cap paths use ORIGINAL extraction indices when grounding dropped earlier entries (F8)", () => {
    const eleven: ImportExtraction = {
      experience: [],
      projects: [],
      education: Array.from({ length: 11 }, (_, i) => ({ school: `School ${i}` })),
      skills: [],
    };
    // Simulate grounding having dropped original entry 3: the 11 kept
    // entries carry original indices 0..2,4..12 — the over-cap report must
    // name the ORIGINAL index (12), matching the not-verbatim index base.
    const keptIndices = {
      experience: [],
      projects: [],
      education: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 12],
      skills: [],
    };
    const { overCap } = toImportedEntries(
      eleven,
      { mintId: () => "id", now: () => "2026-07-12T00:00:00.000Z" },
      keptIndices,
    );
    expect(overCap).toEqual([
      { path: "education[12]", text: "School 10", reason: "over-cap" },
    ]);
  });

  it("trims to the profile caps with honest over-cap reports (never a zod failure downstream)", () => {
    const many: ImportExtraction = {
      experience: [],
      projects: [],
      education: Array.from({ length: 12 }, (_, i) => ({ school: `School ${i}` })),
      skills: [],
    };
    const mint = vi.fn(() => "id");
    const { entries, overCap } = toImportedEntries(many, {
      mintId: mint,
      now: () => "2026-07-12T00:00:00.000Z",
    });
    expect(entries.education).toHaveLength(10);
    expect(overCap).toEqual([
      { path: "education[10]", text: "School 10", reason: "over-cap" },
      { path: "education[11]", text: "School 11", reason: "over-cap" },
    ]);
  });
});
