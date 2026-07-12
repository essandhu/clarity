import { toRunErrorEvent } from "@/domain/pipeline/errors";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import {
  ImportExtractionSchema,
  type ImportExtraction,
  type ImportedEntries,
  type ImportReport,
  type PipelineEvent,
} from "@/shared/schema";
import { groundImportExtraction, type GroundedImport } from "./resumeImportGrounding";
import { capImportText, resumeImportPrompt } from "./resumeImportPrompt";

// The pasted-resume import run (PLAN-RESUME.md §4.5) — runDraft's shape: a
// synchronous .started at seq 0, ONE stream-backed extract (decision 58),
// the verbatim grounding gate, then ids + provenance stamped HERE, after
// grounding — the model-facing schema has neither, so the honesty label is
// structurally model-inaccessible. Silent-return-on-abort throughout.

export type EmitImportEvent = (event: PipelineEvent) => void;

export interface ResumeImportDeps {
  /** Lazy: a misconfigured provider surfaces as run.error ON the stream. */
  getModel(): ModelProvider;
  /** Injected id mint (node:crypto never in domain — §4.4). */
  mintId(): string;
  /** Injected clock read for provenance.importedAt (decision 22's spirit). */
  now(): string;
}

export interface ResumeImportSignals {
  cancel: AbortSignal;
}

// The stored profile's zod caps (MasterProfileSchema): the mapping trims to
// fit and reports the excess — a legal-but-oversized extraction must never
// become a zod failure on the terminal frame.
const SECTION_CAPS = { experience: 30, projects: 30, education: 10, skills: 10 } as const;

export async function runResumeImport(
  text: string,
  deps: ResumeImportDeps,
  emit: EmitImportEvent,
  signals: ResumeImportSignals,
): Promise<void> {
  emit({ type: "profile.import.started" });
  try {
    if (signals.cancel.aborted) return;
    const model = deps.getModel();
    const { text: capped, truncated } = capImportText(text);
    const { system, prompt } = resumeImportPrompt(capped);
    const raw = await model.extract(prompt, ImportExtractionSchema, {
      system,
      temperature: 0,
      abortSignal: signals.cancel,
      streamProgress: true, // decision 58: deltas feed the watchdog
    });
    if (signals.cancel.aborted) return;
    // Ground against EXACTLY what the model saw — the capped slice.
    const { extraction, droppedStrings, keptIndices } = groundImportExtraction(raw, capped);
    const { entries, overCap } = toImportedEntries(extraction, deps, keptIndices);
    const report: ImportReport = {
      droppedStrings: [...droppedStrings, ...overCap],
      truncated,
      notes: truncated
        ? [`Only the first ${capped.length.toLocaleString()} characters were analyzed.`]
        : [],
    };
    emit({ type: "profile.import.completed", entries, report });
  } catch (err) {
    if (signals.cancel.aborted) return; // the sink is dead — say nothing
    emit(toRunErrorEvent(err));
  }
}

/** Grounded extraction → real profile entries: ids minted, provenance
 *  stamped, profile-schema caps enforced with honest over-cap reports.
 *  Over-cap paths are numbered in the ORIGINAL extraction's index base (via
 *  keptIndices) so the one droppedStrings list never mixes two numbering
 *  schemes (review F8). */
export function toImportedEntries(
  extraction: ImportExtraction,
  deps: Pick<ResumeImportDeps, "mintId" | "now">,
  keptIndices?: GroundedImport["keptIndices"],
): { entries: ImportedEntries; overCap: ImportReport["droppedStrings"] } {
  const overCap: ImportReport["droppedStrings"] = [];
  const provenance = { origin: "pasted-resume" as const, importedAt: deps.now() };
  const cap = <T>(items: T[], section: keyof typeof SECTION_CAPS, label: (item: T) => string) => {
    const max = SECTION_CAPS[section];
    items.slice(max).forEach((item, i) => {
      const originalIndex = keptIndices?.[section][max + i] ?? max + i;
      overCap.push({
        path: `${section}[${originalIndex}]`,
        text: label(item).slice(0, 120),
        reason: "over-cap",
      });
    });
    return items.slice(0, max);
  };
  const bullets = (texts: string[]) =>
    texts.map((bulletText) => ({ id: deps.mintId(), text: bulletText }));

  return {
    entries: {
      experience: cap(extraction.experience, "experience", (e) => e.org).map((entry) => ({
        id: deps.mintId(),
        org: entry.org,
        role: entry.role,
        ...(entry.location !== undefined ? { location: entry.location } : {}),
        ...(entry.startDate !== undefined ? { startDate: entry.startDate } : {}),
        ...(entry.endDate !== undefined ? { endDate: entry.endDate } : {}),
        bullets: bullets(entry.bullets),
        provenance,
      })),
      projects: cap(extraction.projects, "projects", (p) => p.name).map((entry) => ({
        id: deps.mintId(),
        name: entry.name,
        technologies: entry.technologies,
        ...(entry.startDate !== undefined ? { startDate: entry.startDate } : {}),
        ...(entry.endDate !== undefined ? { endDate: entry.endDate } : {}),
        bullets: bullets(entry.bullets),
        provenance,
      })),
      education: cap(extraction.education, "education", (e) => e.school).map((entry) => ({
        id: deps.mintId(),
        school: entry.school,
        ...(entry.degree !== undefined ? { degree: entry.degree } : {}),
        ...(entry.location !== undefined ? { location: entry.location } : {}),
        ...(entry.startDate !== undefined ? { startDate: entry.startDate } : {}),
        ...(entry.endDate !== undefined ? { endDate: entry.endDate } : {}),
        ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
        provenance,
      })),
      skills: cap(extraction.skills, "skills", (s) => s.category).map((group) => ({
        id: deps.mintId(),
        category: group.category,
        items: group.items,
      })),
    },
    overCap,
  };
}
