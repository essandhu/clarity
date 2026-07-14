"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { MasterProfileSchema, type ListingProfile, type MasterProfile } from "@/shared/schema";
import { CoveragePanel } from "./CoveragePanel";
import { ImportPanel } from "./ImportPanel";
import { MasterProfilePanel } from "./MasterProfilePanel";
import { ResumeOutputPanel } from "./ResumeOutputPanel";
import { consumeTailorHandoff } from "./tailorHandoff";
import { TailorPanel } from "./TailorPanel";
import { useMasterProfile } from "./useMasterProfile";
import { useTailorRun } from "./useTailorRun";

// The /resume page shell (PLAN-RESUME.md §6). Increment 11 shipped the
// master profile + pasted-resume import; 12 added the GitHub / LinkedIn
// importers and the chips row; 13 adds the tailor panel, coverage, and the
// what-changed output (downloads land in 14, the PDF preview in 15).

const TectonicHealthSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  warmed: z.boolean(),
});
const HealthSchema = z.object({
  github: z.object({ tokenConfigured: z.boolean() }),
  tectonic: TectonicHealthSchema,
});
type TectonicHealth = z.infer<typeof TectonicHealthSchema>;

/** Static chip (decision 56): tokenConfigured is env presence read by the
 *  health route — rendering it costs zero GitHub dials. */
function githubChip(tokenConfigured: boolean | undefined): { text: string; tone: string } {
  if (tokenConfigured === undefined) return { text: "GitHub · checking…", tone: "muted" };
  return tokenConfigured
    ? { text: "GitHub · token configured", tone: "ok" }
    : { text: "GitHub · keyless (60 req/hr, pins need a token)", tone: "muted" };
}

/** Local binary probe (decision 50/56): a not-found Tectonic is honest
 *  degradation, not an error — the .tex download always works. */
function tectonicChip(tectonic: TectonicHealth | undefined): { text: string; tone: string } {
  if (tectonic === undefined) return { text: "Tectonic · checking…", tone: "muted" };
  if (!tectonic.available) return { text: "Tectonic · not found (.tex only)", tone: "muted" };
  return { text: `Tectonic ${tectonic.version ?? ""} · PDF ready`.replace("  ", " "), tone: "ok" };
}

export function ResumeView() {
  const editor = useMasterProfile();
  const tailor = useTailorRun();
  const [tokenConfigured, setTokenConfigured] = useState<boolean>();
  const [tectonic, setTectonic] = useState<TectonicHealth>();
  const [handoff, setHandoff] = useState<ListingProfile | null>(null);
  // The guided-flow step (PLAN-RESUME §6 IA): Profile → Tailor → Review. Bodies
  // stay mounted and toggle with `hidden` so the output panel's toggle/tab state
  // and its tailorRunId-keyed remount survive step switches.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // The master the RUN tailored from — decision 37's disk truth, snapshotted
  // per run (review F6): the live editor draft can drift mid-session (unsaved
  // edits, deletions), and the diff/toggle surface must compare against what
  // the route actually loaded, not what the editor currently shows.
  const [runMaster, setRunMaster] = useState<{ runId: number; master: MasterProfile } | null>(
    null,
  );

  // Consumed post-hydration (sessionStorage is client-only; a useState
  // initializer would desync SSR markup). Microtask-deferred: the lint rule
  // forbids synchronous setState in an effect body. Read-once: corrupt
  // payloads vanish silently.
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      const consumed = consumeTailorHandoff();
      setHandoff(consumed);
      // A handoff from Analyze lands the user directly on the Tailor step.
      if (consumed) setStep(2);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: unknown) => {
        const parsed = HealthSchema.safeParse(body);
        if (alive && parsed.success) {
          setTokenConfigured(parsed.data.github.tokenConfigured);
          setTectonic(parsed.data.tectonic);
        }
      })
      .catch(() => {
        // Health is advisory; the chip just stays in its loading state.
      });
    return () => {
      alive = false;
    };
  }, []);

  const { state } = tailor;
  useEffect(() => {
    if (state.phase !== "done" || state.resume === undefined) return;
    const runId = state.tailorRunId;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/profile", { signal: controller.signal });
        const body: unknown = await res.json();
        if (!body || typeof body !== "object" || (body as { kind?: unknown }).kind !== "ok") {
          return; // no snapshot ⇒ the output panel simply stays unmounted
        }
        const parsed = MasterProfileSchema.safeParse((body as { profile: unknown }).profile);
        if (parsed.success) setRunMaster({ runId, master: parsed.data });
      } catch {
        // Aborted or unreachable — same honest degradation as above.
      }
    })();
    return () => controller.abort();
  }, [state.phase, state.resume, state.tailorRunId]);

  // Advance to Review once a tailor run completes (the natural next step). Deps
  // are the run outcome only, so stepping back manually never re-triggers it.
  useEffect(() => {
    if (state.phase !== "done" || !state.resume || !state.coverage) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) setStep(3);
    });
    return () => {
      alive = false;
    };
  }, [state.phase, state.resume, state.coverage]);

  const chip = githubChip(tokenConfigured);
  const texChip = tectonicChip(tectonic);

  return (
    <div className="resume-view">
      <header className="page-hero">
        <h1 className="page-title">Resume</h1>
        <p className="tagline">
          Build a master profile once; tailor it to any role. Everything stays on your machine,
          and nothing is ever invented on your behalf.
        </p>
      </header>

      <nav className="stepper" aria-label="Resume steps">
        {(
          [
            [1, "Profile"],
            [2, "Tailor"],
            [3, "Review & Download"],
          ] as const
        ).map(([n, label]) => (
          <button
            key={n}
            type="button"
            className={step === n ? "step-tab active" : "step-tab"}
            aria-current={step === n ? "step" : undefined}
            onClick={() => setStep(n)}
          >
            <span className="step-index" aria-hidden="true">
              {n}
            </span>
            {label}
          </button>
        ))}
      </nav>

      <div className="chips-row">
        <span className={`provider-chip provider-${chip.tone}`} title="GitHub import quota">
          {chip.text}
        </span>
        <span className={`provider-chip provider-${texChip.tone}`} title="Local PDF compiler">
          {texChip.text}
        </span>
      </div>

      <div className="resume-step" hidden={step !== 1}>
        <MasterProfilePanel editor={editor} />
        <ImportPanel canMerge={editor.draft !== null} onMerge={editor.merge} />
      </div>

      <div className="resume-step" hidden={step !== 2}>
        <TailorPanel run={tailor} handoff={handoff} onDismissHandoff={() => setHandoff(null)} />
      </div>

      <div className="resume-step" hidden={step !== 3}>
        {state.phase === "done" && state.resume && state.coverage ? (
          <>
            <CoveragePanel coverage={state.coverage} resume={state.resume} />
            {runMaster?.runId === state.tailorRunId && (
              <ResumeOutputPanel
                key={state.tailorRunId}
                resume={state.resume}
                coverage={state.coverage}
                master={runMaster.master}
                tectonic={tectonic}
              />
            )}
          </>
        ) : (
          <p className="profile-status">
            Tailor a role in the Tailor step to see your tailored resume, the change diff, and the
            downloads here.
          </p>
        )}
      </div>
    </div>
  );
}
