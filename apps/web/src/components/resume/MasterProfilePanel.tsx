"use client";

import { IdentityFields } from "./IdentityFields";
import { ProfileEntryCard } from "./ProfileEntryCard";
import {
  addBullet,
  addEntry,
  fieldErrors,
  mintClientId,
  moveEntry,
  patchBullet,
  patchEntry,
  patchIdentity,
  removeBullet,
  removeEntry,
  type EntrySection,
} from "./profileEditorState";
import type { MasterProfileEditor } from "./useMasterProfile";

// The master-profile editor panel (§6): honest empty/unreadable states, the
// per-section entry lists, and the explicit Save (imports land here UNSAVED
// — decision 42; the dirty state is the undo boundary and the copy says so).

const SECTIONS: { key: EntrySection; title: string; hasBullets: boolean }[] = [
  { key: "experience", title: "Experience", hasBullets: true },
  { key: "projects", title: "Projects", hasBullets: true },
  { key: "education", title: "Education", hasBullets: false },
  { key: "skills", title: "Skills", hasBullets: false },
];

export function MasterProfilePanel({ editor }: { editor: MasterProfileEditor }) {
  if (editor.status === "loading") {
    return <p className="profile-status">Loading your profile…</p>;
  }
  if (editor.status === "load_error") {
    return (
      <div className="error-banner" role="alert">
        <strong>Could not load your profile</strong>
        <p>{editor.loadError}</p>
      </div>
    );
  }
  if (editor.status === "unreadable" && editor.unreadable) {
    return (
      <div className="error-banner" role="alert">
        <strong>Your saved profile file is unreadable</strong>
        <p>{editor.unreadable.detail}</p>
        <p>
          The previous save is kept at <code>{editor.unreadable.bakPath}</code> — restore it by
          copying it over <code>data/profile/master.json</code>, or start fresh below (the
          unreadable file is moved aside, never deleted).
        </p>
        <button type="button" className="ghost-button" onClick={editor.startFresh}>
          Start fresh (overwrites explicitly)
        </button>
      </div>
    );
  }
  const draft = editor.draft;
  if (!draft) return null;

  const errors = fieldErrors(draft);
  const errorCount = Object.keys(errors).length;
  const firstError = Object.entries(errors)[0];
  const empty =
    draft.experience.length + draft.projects.length + draft.education.length + draft.skills.length ===
    0;

  return (
    <section className="master-profile" aria-label="Master profile">
      <h2 className="section-heading">Master profile</h2>
      {empty && (
        <p className="profile-status">
          No master profile yet — import your resume below, or add entries by hand.
        </p>
      )}

      <IdentityFields
        identity={draft.identity}
        errors={errors}
        onPatch={(patch) => editor.edit((p) => patchIdentity(p, patch))}
      />

      {SECTIONS.map((section) => {
        const entries = draft[section.key];
        return (
          <div key={section.key} className="profile-section">
            <div className="profile-section-head">
              <h3 className="entry-label">{section.title}</h3>
              <button
                type="button"
                className="ghost-button entry-add"
                onClick={() =>
                  editor.edit((p) =>
                    addEntry(p, section.key, mintClientId, new Date().toISOString()),
                  )
                }
              >
                Add entry
              </button>
            </div>
            {entries.map((entry, index) => (
              <ProfileEntryCard
                key={entry.id}
                section={section.key}
                entry={entry}
                index={index}
                count={entries.length}
                errors={errors}
                onPatch={(patch) => editor.edit((p) => patchEntry(p, section.key, entry.id, patch))}
                onDelete={() => editor.edit((p) => removeEntry(p, section.key, entry.id))}
                onMove={(delta) => editor.edit((p) => moveEntry(p, section.key, entry.id, delta))}
                {...(section.hasBullets
                  ? {
                      onBulletAdd: () =>
                        editor.edit((p) =>
                          addBullet(
                            p,
                            section.key as "experience" | "projects",
                            entry.id,
                            mintClientId,
                          ),
                        ),
                      onBulletPatch: (bulletId: string, text: string) =>
                        editor.edit((p) =>
                          patchBullet(
                            p,
                            section.key as "experience" | "projects",
                            entry.id,
                            bulletId,
                            text,
                          ),
                        ),
                      onBulletRemove: (bulletId: string) =>
                        editor.edit((p) =>
                          removeBullet(
                            p,
                            section.key as "experience" | "projects",
                            entry.id,
                            bulletId,
                          ),
                        ),
                    }
                  : {})}
              />
            ))}
          </div>
        );
      })}

      <div className="profile-save-row">
        <button
          type="button"
          className="primary-button"
          disabled={!editor.dirty || editor.saving || errorCount > 0}
          onClick={editor.save}
          title={firstError ? `Fix ${firstError[0]} — ${firstError[1]}` : undefined}
        >
          {editor.saving ? "Saving…" : "Save profile"}
        </button>
        {editor.dirty && (
          <span className="profile-dirty" role="status">
            Unsaved changes — reloading the page discards them.
          </span>
        )}
        {firstError && (
          <span className="input-error">
            Fix {firstError[0]} — {firstError[1]}
          </span>
        )}
        {!editor.dirty && editor.savedAt && (
          <span className="profile-status">Saved {new Date(editor.savedAt).toLocaleTimeString()}.</span>
        )}
        {editor.lastMerge && editor.dirty && editor.lastMerge.added > 0 && (
          <span className="profile-status">
            Import added {editor.lastMerge.added}
            {editor.lastMerge.skipped > 0
              ? `, skipped ${editor.lastMerge.skipped} already-present`
              : ""}{" "}
            — review, then Save.
          </span>
        )}
        {editor.lastMerge && editor.lastMerge.added === 0 && (
          <span className="profile-status">
            Import added nothing new — every entry was already in your profile.
          </span>
        )}
      </div>
      {editor.saveError && (
        <div className="error-banner" role="alert">
          <strong>Save failed</strong>
          <p>{editor.saveError}</p>
        </div>
      )}
    </section>
  );
}
