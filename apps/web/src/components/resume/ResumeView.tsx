"use client";

import { ImportPanel } from "./ImportPanel";
import { MasterProfilePanel } from "./MasterProfilePanel";
import { useMasterProfile } from "./useMasterProfile";

// The /resume page shell (PLAN-RESUME.md §6). Increment 11 ships the master
// profile + pasted-resume import; the GitHub/LinkedIn importers (12), the
// tailor panel (13), and the output panel (14/15) mount here later. The
// chips row arrives with its first chip (GitHub, increment 12).

export function ResumeView() {
  const editor = useMasterProfile();

  return (
    <div className="resume-view">
      <header className="app-header">
        <h1>Clarity — Resume</h1>
        <p className="tagline">
          Build a master profile once; tailor it to any role. Everything stays on your machine,
          and nothing is ever invented on your behalf.
        </p>
      </header>

      <MasterProfilePanel editor={editor} />

      <ImportPanel canMerge={editor.draft !== null} onMerge={editor.merge} />
    </div>
  );
}
