"use client";

import { useEffect, useRef, useState } from "react";
import {
  GithubReposResponseSchema,
  ImportedEntriesSchema,
  ImportReportSchema,
  type GithubReposResponse,
  type ImportedEntries,
  type ImportReport,
} from "@/shared/schema";
import { z } from "zod";
import { readErrorMessage } from "../sseClient";
import { countEntries, DropReport, ImportNotes } from "./importReport";

// GitHub import affordance (§6): username -> stage-A repo picker (stars /
// pinned / fork badges, rate-remaining FROM the stage-A response, keyless
// order labeled honestly) -> tick repos -> stage-B import -> merge. Both
// stages are user-initiated clicks — nothing dials GitHub on mount.

const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const MAX_PICKED = 30;

const ImportResponseSchema = z.object({
  entries: ImportedEntriesSchema,
  report: ImportReportSchema,
});

type Phase =
  | { kind: "idle" }
  | { kind: "listing" }
  | { kind: "listed"; listed: GithubReposResponse }
  | { kind: "importing"; listed: GithubReposResponse }
  | { kind: "done"; entries: ImportedEntries; report: ImportReport };

export function GithubImportSection(props: {
  canMerge: boolean;
  onMerge(entries: ImportedEntries): void;
}) {
  const [username, setUsername] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  // Abort the in-flight request on unmount (the increment-8 useDraftRun
  // lesson): a stage-B serial import must not keep spending keyless quota
  // with nobody listening.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const armAbort = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  const listRepos = async () => {
    const login = username.trim();
    if (!USERNAME_PATTERN.test(login)) {
      setError("Enter a GitHub username — 1 to 39 letters, digits, or hyphens.");
      return;
    }
    setError(undefined);
    setPhase({ kind: "listing" });
    const controller = armAbort();
    try {
      const res = await fetch("/api/profile/import/github/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: login }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPhase({ kind: "idle" });
        return;
      }
      const parsed = GithubReposResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setError("Unexpected response shape from the repo listing.");
        setPhase({ kind: "idle" });
        return;
      }
      setPicked(new Set());
      setPhase({ kind: "listed", listed: parsed.data });
    } catch {
      if (controller.signal.aborted) return; // unmounted — say nothing
      setError("Could not reach /api/profile/import/github/repos.");
      setPhase({ kind: "idle" });
    }
  };

  const importPicked = async (listed: GithubReposResponse) => {
    setError(undefined);
    setPhase({ kind: "importing", listed });
    const controller = armAbort();
    try {
      const res = await fetch("/api/profile/import/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), repos: [...picked] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPhase({ kind: "listed", listed });
        return;
      }
      const parsed = ImportResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setError("Unexpected response shape from the import.");
        setPhase({ kind: "listed", listed });
        return;
      }
      setPhase({ kind: "done", entries: parsed.data.entries, report: parsed.data.report });
    } catch {
      if (controller.signal.aborted) return; // unmounted — say nothing
      setError("Could not reach /api/profile/import/github.");
      setPhase({ kind: "listed", listed });
    }
  };

  const togglePick = (name: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
        setError(undefined);
      } else if (next.size < MAX_PICKED) {
        next.add(name);
        setError(undefined);
      } else {
        // The cap fires with named copy (the increment-11 F15 rule) — a
        // silently ignored tick would misreport what will be imported.
        setError(`Up to ${MAX_PICKED} repos per import — untick one first.`);
      }
      return next;
    });
  };

  return (
    <div className="import-section">
      <h3 className="import-subheading">From GitHub</h3>
      {(phase.kind === "idle" || phase.kind === "listing") && (
        <div className="import-inline-form">
          <input
            type="text"
            aria-label="GitHub username"
            placeholder="GitHub username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={phase.kind === "listing"}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void listRepos()}
            disabled={phase.kind === "listing"}
          >
            {phase.kind === "listing" ? "Listing…" : "List repositories"}
          </button>
        </div>
      )}

      {(phase.kind === "listed" || phase.kind === "importing") && (
        <div className="repo-picker">
          <p className="profile-status">
            {phase.listed.repos.length} public {phase.listed.repos.length === 1 ? "repo" : "repos"}{" "}
            listed{phase.listed.repos.length >= 100 ? " (the 100 most recently pushed)" : ""}
            {" · "}
            {phase.listed.order === "pinned-first"
              ? "pinned first, then by stars"
              : "by stars — pins need a token"}
            {" · "}
            {phase.listed.rate.remaining}/{phase.listed.rate.limit} GitHub requests remaining this
            hour
          </p>
          <ul className="repo-list">
            {phase.listed.repos.map((repo) => (
              <li key={repo.fullName}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(repo.name)}
                    onChange={() => togglePick(repo.name)}
                    disabled={phase.kind === "importing"}
                  />{" "}
                  <strong>{repo.name}</strong>
                  {repo.pinned && <span className="chip">pinned</span>}
                  <span className="chip">★ {repo.stars}</span>
                  {repo.fork && <span className="chip">fork</span>}
                  {repo.archived && <span className="chip">archived</span>}
                  {repo.description && <span className="repo-description"> — {repo.description}</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="draft-actions">
            <button
              type="button"
              className="primary-button"
              disabled={picked.size === 0 || phase.kind === "importing"}
              onClick={() => void importPicked(phase.listed)}
            >
              {phase.kind === "importing"
                ? "Importing…"
                : `Import ${picked.size} ${picked.size === 1 ? "repo" : "repos"}`}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={phase.kind === "importing"}
              onClick={() => {
                setError(undefined);
                setPhase({ kind: "idle" });
              }}
            >
              Change user
            </button>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="import-result">
          <p className="profile-status">
            Imported {countEntries(phase.entries)} project{" "}
            {countEntries(phase.entries) === 1 ? "entry" : "entries"} — bullets are yours to write
            in the editor (descriptions and topics come over verbatim; nothing is generated).
          </p>
          <DropReport droppedStrings={phase.report.droppedStrings} />
          <ImportNotes notes={phase.report.notes} />
          <div className="draft-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!props.canMerge || countEntries(phase.entries) === 0}
              onClick={() => {
                props.onMerge(phase.entries);
                setPhase({ kind: "idle" });
              }}
            >
              Add to profile
            </button>
            <button type="button" className="ghost-button" onClick={() => setPhase({ kind: "idle" })}>
              Discard
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="input-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
