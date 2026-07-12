"use client";

import { useState } from "react";
import type {
  EducationEntry,
  ExperienceEntry,
  ProjectEntry,
  SkillGroup,
} from "@/shared/schema";
import { parseCsvList, type EntrySection } from "./profileEditorState";

// One editable entry (§6 editor contract): inline per-field inputs with zod
// validation copy shown ON BLUR (touched-gated — a field the user never
// visited must not paint "required"; the always-on Save-row line is the
// on-Save surface), delete, up/down reorder (order is meaningful — it feeds
// the tailor prompt cap and the fallback selection), bullets for
// experience/projects, and a read-only provenance badge.

type AnyEntry = ExperienceEntry | ProjectEntry | EducationEntry | SkillGroup;

interface FieldSpec {
  key: string;
  label: string;
  csv?: boolean;
}

const FIELDS: Record<EntrySection, FieldSpec[]> = {
  experience: [
    { key: "org", label: "Organization" },
    { key: "role", label: "Role" },
    { key: "location", label: "Location" },
    { key: "startDate", label: "Start date" },
    { key: "endDate", label: "End date (blank = current)" },
  ],
  projects: [
    { key: "name", label: "Name" },
    { key: "url", label: "Link (https://…)" },
    { key: "technologies", label: "Technologies (comma-separated)", csv: true },
    { key: "startDate", label: "Start date" },
    { key: "endDate", label: "End date" },
  ],
  education: [
    { key: "school", label: "School" },
    { key: "degree", label: "Degree" },
    { key: "location", label: "Location" },
    { key: "startDate", label: "Start date" },
    { key: "endDate", label: "End date" },
    { key: "notes", label: "Notes" },
  ],
  skills: [
    { key: "category", label: "Category" },
    { key: "items", label: "Items (comma-separated)", csv: true },
  ],
};

const BULLET_CAPS = { experience: 12, projects: 8 } as const;

export function ProfileEntryCard(props: {
  section: EntrySection;
  entry: AnyEntry;
  index: number;
  count: number;
  errors: Record<string, string>;
  onPatch(patch: Record<string, unknown>): void;
  onDelete(): void;
  onMove(delta: -1 | 1): void;
  onBulletAdd?(): void;
  onBulletPatch?(bulletId: string, text: string): void;
  onBulletRemove?(bulletId: string): void;
}) {
  const { section, entry, index, count, errors } = props;
  // §6: validation copy "shown on blur and on Save" — an untouched field
  // stays quiet even while its zod issue blocks Save (review F14).
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((prev) => new Set(prev).add(key));
  const errorFor = (key: string) =>
    errors[`${section}.${index}.${key}`] ??
    Object.entries(errors).find(([path]) => path.startsWith(`${section}.${index}.${key}.`))?.[1];
  const bullets =
    section === "experience" || section === "projects"
      ? (entry as ExperienceEntry | ProjectEntry).bullets
      : undefined;
  const bulletCap = section === "experience" || section === "projects" ? BULLET_CAPS[section] : 0;
  const provenance = "provenance" in entry ? entry.provenance : undefined;

  return (
    <div className="card entry-card">
      <div className="entry-head">
        {provenance && (
          <span className="chip entry-provenance" title={`Imported ${provenance.importedAt}`}>
            {provenance.origin}
          </span>
        )}
        <span className="entry-actions">
          <button
            type="button"
            className="entry-action"
            onClick={() => props.onMove(-1)}
            disabled={index === 0}
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="entry-action"
            onClick={() => props.onMove(1)}
            disabled={index === count - 1}
            aria-label="Move down"
          >
            ↓
          </button>
          <button type="button" className="entry-action entry-delete" onClick={props.onDelete}>
            Remove
          </button>
        </span>
      </div>

      {FIELDS[section].map((field) => {
        const error = touched.has(field.key) ? errorFor(field.key) : undefined;
        const raw = (entry as unknown as Record<string, unknown>)[field.key];
        return (
          <label key={field.key} className="entry-field">
            <span className="entry-label">{field.label}</span>
            {field.csv ? (
              <CsvInput
                key={`${entry.id}-${(raw as string[] | undefined)?.join("|") ?? ""}`}
                value={(raw as string[] | undefined) ?? []}
                onCommit={(items) => {
                  touch(field.key);
                  props.onPatch({ [field.key]: items });
                }}
              />
            ) : (
              <input
                value={typeof raw === "string" ? raw : ""}
                onBlur={() => touch(field.key)}
                onChange={(e) =>
                  props.onPatch({
                    [field.key]:
                      e.target.value === "" ? blankValue(section, field.key) : e.target.value,
                  })
                }
              />
            )}
            {error && (
              <span className="input-error">
                {field.label.replace(/\s*\(.*\)$/, "")} — {error}
              </span>
            )}
          </label>
        );
      })}

      {bullets && props.onBulletPatch && (
        <div className="entry-bullets">
          <span className="entry-label">Bullets ({bullets.length}/{bulletCap})</span>
          {bullets.map((bullet, bi) => (
            <div key={bullet.id} className="entry-bullet-row">
              <textarea
                rows={2}
                aria-label={`Bullet ${bi + 1}`}
                value={bullet.text}
                onBlur={() => touch(`bullets.${bullet.id}`)}
                onChange={(e) => props.onBulletPatch?.(bullet.id, e.target.value)}
              />
              <button
                type="button"
                className="entry-action entry-delete"
                onClick={() => props.onBulletRemove?.(bullet.id)}
                aria-label="Remove bullet"
              >
                ×
              </button>
              {touched.has(`bullets.${bullet.id}`) &&
                errors[`${section}.${index}.bullets.${bi}.text`] && (
                  <span className="input-error">
                    bullet — {errors[`${section}.${index}.bullets.${bi}.text`]}
                  </span>
                )}
            </div>
          ))}
          <button
            type="button"
            className="ghost-button entry-add-bullet"
            onClick={props.onBulletAdd}
            disabled={bullets.length >= bulletCap}
            title={bullets.length >= bulletCap ? `${bulletCap} bullets max` : undefined}
          >
            Add bullet
          </button>
        </div>
      )}
    </div>
  );
}

/** Blank text means ABSENT for optional fields (the schema's absence rule);
 *  required fields keep "" so the zod issue names them. */
function blankValue(section: EntrySection, key: string): string | undefined {
  const required =
    (section === "experience" && (key === "org" || key === "role")) ||
    (section === "projects" && key === "name") ||
    (section === "education" && key === "school") ||
    (section === "skills" && key === "category");
  return required ? "" : undefined;
}

/** Comma-list editing needs local text state (parsing per keystroke would
 *  eat the comma the user just typed); committed UNCAPPED on blur — the zod
 *  max fires with named copy rather than items vanishing silently (F15) —
 *  and remounted by the parent's key when the array changes externally. */
function CsvInput(props: { value: string[]; onCommit(items: string[]): void }) {
  const [text, setText] = useState(props.value.join(", "));
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => props.onCommit(parseCsvList(text))}
    />
  );
}
