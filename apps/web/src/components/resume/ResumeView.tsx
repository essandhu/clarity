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
      if (alive) setHandoff(consumeTailorHandoff());
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

  const chip = githubChip(tokenConfigured);
  const texChip = tectonicChip(tectonic);

  return (
    <div className="resume-view">
      <header className="app-header">
        <h1>Clarity — Resume</h1>
        <p className="tagline">
          Build a master profile once; tailor it to any role. Everything stays on your machine,
          and nothing is ever invented on your behalf.
        </p>
        <div className="chips-row">
          <span className={`provider-chip provider-${chip.tone}`} title="GitHub import quota">
            {chip.text}
          </span>
          <span className={`provider-chip provider-${texChip.tone}`} title="Local PDF compiler">
            {texChip.text}
          </span>
        </div>
      </header>

      <MasterProfilePanel editor={editor} />

      <ImportPanel canMerge={editor.draft !== null} onMerge={editor.merge} />

      <TailorPanel run={tailor} handoff={handoff} onDismissHandoff={() => setHandoff(null)} />

      {state.phase === "done" && state.resume && state.coverage && (
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
      )}
    </div>
  );
}
