"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import type { ListingProfile } from "@/shared/schema";
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

const HealthSchema = z.object({
  github: z.object({ tokenConfigured: z.boolean() }),
});

/** Static chip (decision 56): tokenConfigured is env presence read by the
 *  health route — rendering it costs zero GitHub dials. */
function githubChip(tokenConfigured: boolean | undefined): { text: string; tone: string } {
  if (tokenConfigured === undefined) return { text: "GitHub · checking…", tone: "muted" };
  return tokenConfigured
    ? { text: "GitHub · token configured", tone: "ok" }
    : { text: "GitHub · keyless (60 req/hr, pins need a token)", tone: "muted" };
}

export function ResumeView() {
  const editor = useMasterProfile();
  const tailor = useTailorRun();
  const [tokenConfigured, setTokenConfigured] = useState<boolean>();
  const [handoff, setHandoff] = useState<ListingProfile | null>(null);

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
        if (alive && parsed.success) setTokenConfigured(parsed.data.github.tokenConfigured);
      })
      .catch(() => {
        // Health is advisory; the chip just stays in its loading state.
      });
    return () => {
      alive = false;
    };
  }, []);

  const chip = githubChip(tokenConfigured);
  const { state } = tailor;

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
        </div>
      </header>

      <MasterProfilePanel editor={editor} />

      <ImportPanel canMerge={editor.draft !== null} onMerge={editor.merge} />

      <TailorPanel run={tailor} handoff={handoff} onDismissHandoff={() => setHandoff(null)} />

      {state.phase === "done" && state.resume && state.coverage && (
        <>
          <CoveragePanel coverage={state.coverage} resume={state.resume} />
          {editor.draft && (
            <ResumeOutputPanel
              key={state.tailorRunId}
              resume={state.resume}
              coverage={state.coverage}
              master={editor.draft}
            />
          )}
        </>
      )}
    </div>
  );
}
