"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { ImportPanel } from "./ImportPanel";
import { MasterProfilePanel } from "./MasterProfilePanel";
import { useMasterProfile } from "./useMasterProfile";

// The /resume page shell (PLAN-RESUME.md §6). Increment 11 shipped the
// master profile + pasted-resume import; increment 12 adds the GitHub /
// LinkedIn importers and the chips row (its first chip — Tectonic joins in
// 15). The tailor panel (13) and output panel (14/15) mount here later.

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
  const [tokenConfigured, setTokenConfigured] = useState<boolean>();

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
    </div>
  );
}
