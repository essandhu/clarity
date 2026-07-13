import { describe, expect, it } from "vitest";
import { PipelineError } from "@/domain/pipeline/errors";
import { PipelineEventSchema, type PipelineEvent, type TailorRoleInput } from "@/shared/schema";
import {
  FALLBACK_SKIP_DETAIL,
  runTailor,
  STEP_TAILOR_ROLE,
  STEP_TAILOR_SELECT,
} from "./TailorPipeline";
import { makeMaster, makeRole, stubModel } from "./tailorTestKit";

// runTailor (§4.1): event ordering, the decision-40 degradation arm, the
// silent-return-on-abort rule, and the §3-guarantee-3 step pairing. Every
// emitted event is re-validated against the ONE wire schema.

const master = makeMaster();
const profileRole: TailorRoleInput = { kind: "profile", profile: makeRole() };
const textRole: TailorRoleInput = { kind: "text", text: makeRole().rawText };

const extraction = { company: "Tessellate", role: "Platform Engineer" };
const selection = {
  entries: [{ entryId: "e1", bulletIds: ["e1b1"] }],
  skills: [{ category: "Languages", items: ["Go"] }],
};

async function run(role: TailorRoleInput, model: ReturnType<typeof stubModel>, cancel?: AbortSignal) {
  const events: PipelineEvent[] = [];
  await runTailor(role, master, { getModel: () => model }, (e) => events.push(e), {
    cancel: cancel ?? new AbortController().signal,
  });
  for (const event of events) PipelineEventSchema.parse(event);
  return events;
}

describe("runTailor — happy paths", () => {
  it("text path: role step pair + tailor.role.completed precede the selection pair", async () => {
    const events = await run(textRole, stubModel([extraction, selection]));
    expect(events.map((e) => e.type)).toEqual([
      "tailor.started",
      "step.started",
      "step.finished",
      "tailor.role.completed",
      "step.started",
      "step.finished",
      "tailor.completed",
    ]);
    expect(events[1]).toMatchObject({
      stepId: STEP_TAILOR_ROLE,
      stage: "tailor",
      label: "Extracting role profile…",
    });
    expect(events[3]).toMatchObject({ profile: { company: "Tessellate" } });
    expect(events[4]).toMatchObject({
      stepId: STEP_TAILOR_SELECT,
      label: "Selecting from your master profile…",
    });
    const completed = events[6];
    if (completed.type !== "tailor.completed") throw new Error("expected tailor.completed");
    expect(completed.coverage.mode).toBe("tailored");
    expect(completed.resume.entries[0].entryId).toBe("exp-driftlock");
  });

  it("profile path: NO extraction step, NO tailor.role.completed", async () => {
    const events = await run(profileRole, stubModel([selection]));
    expect(events.map((e) => e.type)).toEqual([
      "tailor.started",
      "step.started",
      "step.finished",
      "tailor.completed",
    ]);
    expect(events.some((e) => e.type === "step.started" && e.stepId === STEP_TAILOR_ROLE)).toBe(
      false,
    );
  });

  it("pins the selection call's wiring: streamProgress, temperature 0, the cancel signal", async () => {
    const model = stubModel([selection]);
    const controller = new AbortController();
    await run(profileRole, model, controller.signal);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].opts).toMatchObject({ streamProgress: true, temperature: 0 });
    expect(model.calls[0].opts?.abortSignal).toBe(controller.signal);
    expect(model.calls[0].opts?.system).toBeTruthy();
  });
});

describe("runTailor — the decision-40 degradation arm", () => {
  it("selection EXTRACTION_FAILED ⇒ honest skipped step + fallback-untailored completion", async () => {
    const events = await run(
      profileRole,
      stubModel([new PipelineError("EXTRACTION_FAILED", "selection failed")]),
    );
    expect(events.map((e) => e.type)).toEqual([
      "tailor.started",
      "step.started",
      "step.finished",
      "tailor.completed",
    ]);
    expect(events[2]).toMatchObject({
      stepId: STEP_TAILOR_SELECT,
      status: "skipped",
      skip: { reason: "empty_content", detail: FALLBACK_SKIP_DETAIL },
    });
    const completed = events[3];
    if (completed.type !== "tailor.completed") throw new Error("expected tailor.completed");
    expect(completed.coverage.mode).toBe("fallback-untailored");
    expect(completed.coverage.dropped).toHaveLength(0);
    expect(completed.resume.entries.map((e) => e.entryId)).toEqual([
      "exp-driftlock",
      "exp-acme",
      "proj-driftviz",
    ]);
  });

  it("a watchdog stall (INTERNAL) rethrows: open step paired, run.error INTERNAL", async () => {
    const events = await run(profileRole, stubModel([new PipelineError("INTERNAL", "stalled")]));
    expect(events.map((e) => e.type)).toEqual([
      "tailor.started",
      "step.started",
      "step.finished",
      "run.error",
    ]);
    expect(events[2]).toMatchObject({
      stepId: STEP_TAILOR_SELECT,
      status: "skipped",
      skip: { reason: "cancelled" },
    });
    expect(events[3]).toMatchObject({ code: "INTERNAL" });
  });

  it("a ROLE-extraction failure is fatal — the fallback covers only the selection call", async () => {
    const events = await run(
      textRole,
      stubModel([new PipelineError("EXTRACTION_FAILED", "no role")]),
    );
    expect(events.map((e) => e.type)).toEqual([
      "tailor.started",
      "step.started",
      "step.finished",
      "run.error",
    ]);
    expect(events[2]).toMatchObject({ stepId: STEP_TAILOR_ROLE, status: "skipped" });
    expect(events[3]).toMatchObject({ code: "EXTRACTION_FAILED" });
  });
});

describe("runTailor — configuration + abort", () => {
  it("a misconfigured provider lands MODEL_UNCONFIGURED ON the stream, after tailor.started", async () => {
    const events: PipelineEvent[] = [];
    await runTailor(
      profileRole,
      master,
      {
        getModel: () => {
          throw new PipelineError("MODEL_UNCONFIGURED", "no provider");
        },
      },
      (e) => events.push(e),
      { cancel: new AbortController().signal },
    );
    expect(events.map((e) => e.type)).toEqual(["tailor.started", "run.error"]);
    expect(events[1]).toMatchObject({ code: "MODEL_UNCONFIGURED" });
  });

  it("silent-return-on-abort: an aborted run emits nothing after tailor.started", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await run(profileRole, stubModel([selection]), controller.signal);
    expect(events.map((e) => e.type)).toEqual(["tailor.started"]);
  });
});
