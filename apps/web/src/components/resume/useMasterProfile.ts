"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeImportedEntries } from "@/domain/profile/profileMerge";
import {
  MasterProfileSchema,
  type ImportedEntries,
  type MasterProfile,
} from "@/shared/schema";
import { readErrorMessage } from "../sseClient";
import { blankProfile, snapshot } from "./profileEditorState";

// The master-profile editor's load/save lifecycle (decision 47's client
// half): GET on mount, explicit PUT on Save, the unreadable state as a
// first-class honest surface (draft stays null until the user consents to
// start fresh — a blind overwrite must be a deliberate click, and the PUT
// carries overwrite:true only then). Imports merge into the DRAFT, never
// auto-save (decision 42).

export type ProfileStatus = "loading" | "ready" | "unreadable" | "load_error";

export interface MasterProfileEditor {
  status: ProfileStatus;
  draft: MasterProfile | null;
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  savedAt?: string;
  loadError?: string;
  unreadable?: { detail: string; bakPath: string };
  lastMerge?: { added: number; skipped: number };
  edit(updater: (profile: MasterProfile) => MasterProfile): void;
  save(): void;
  startFresh(): void;
  merge(entries: ImportedEntries): void;
}

export function useMasterProfile(): MasterProfileEditor {
  const [status, setStatus] = useState<ProfileStatus>("loading");
  const [draft, setDraft] = useState<MasterProfile | null>(null);
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [savedAt, setSavedAt] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [unreadable, setUnreadable] = useState<{ detail: string; bakPath: string }>();
  const [lastMerge, setLastMerge] = useState<{ added: number; skipped: number }>();
  // overwrite is ARMED only by the explicit start-fresh click (decision 47).
  const overwriteRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/profile", { signal: controller.signal });
        if (!res.ok) {
          setLoadError(await readErrorMessage(res));
          setStatus("load_error");
          return;
        }
        const body: unknown = await res.json();
        const kind =
          body && typeof body === "object" && "kind" in body
            ? (body as { kind: unknown }).kind
            : undefined;
        if (kind === "ok") {
          const parsed = MasterProfileSchema.safeParse(
            (body as { profile: unknown }).profile,
          );
          if (!parsed.success) {
            setLoadError("The saved profile did not match the expected shape.");
            setStatus("load_error");
            return;
          }
          setDraft(parsed.data);
          setBaseline(snapshot(parsed.data));
          setStatus("ready");
        } else if (kind === "empty") {
          const blank = blankProfile(new Date().toISOString());
          setDraft(blank);
          setBaseline(snapshot(blank));
          setStatus("ready");
        } else if (kind === "unreadable") {
          const info = body as { detail?: unknown; bakPath?: unknown };
          setUnreadable({
            detail: typeof info.detail === "string" ? info.detail : "unreadable profile file",
            bakPath: typeof info.bakPath === "string" ? info.bakPath : "data/profile/master.json.bak",
          });
          setStatus("unreadable");
        } else {
          setLoadError("Unexpected response from /api/profile.");
          setStatus("load_error");
        }
      } catch {
        if (!controller.signal.aborted) {
          setLoadError("Could not reach /api/profile.");
          setStatus("load_error");
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const edit = useCallback((updater: (profile: MasterProfile) => MasterProfile) => {
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const save = useCallback(() => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(undefined);
    const stampedAt = new Date().toISOString();
    const payload = {
      profile: { ...draft, updatedAt: stampedAt },
      ...(overwriteRef.current ? { overwrite: true } : {}),
    };
    void (async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setSaveError(await readErrorMessage(res));
          return;
        }
        const body = (await res.json()) as { savedAt?: string };
        // Functional update: an edit or import-merge landed WHILE the PUT
        // was in flight must survive — only the timestamp is folded in, and
        // any mid-flight divergence keeps the dirty indicator on against
        // the saved baseline (review F5: never clobber live edits with the
        // click-time snapshot).
        setDraft((current) => (current ? { ...current, updatedAt: stampedAt } : current));
        setBaseline(snapshot(payload.profile));
        setSavedAt(body.savedAt ?? stampedAt);
        setUnreadable(undefined);
        setStatus("ready");
        overwriteRef.current = false; // the file is good again
      } catch {
        setSaveError("Could not reach /api/profile to save.");
      } finally {
        setSaving(false);
      }
    })();
  }, [draft, saving]);

  const startFresh = useCallback(() => {
    // The explicit consent click for the unreadable state: editing starts
    // from blank and the NEXT save carries overwrite:true (the store moves
    // the unreadable file aside — never over the .bak).
    overwriteRef.current = true;
    const blank = blankProfile(new Date().toISOString());
    setDraft(blank);
    setBaseline(snapshot(blank));
    setStatus("ready");
  }, []);

  const merge = useCallback((entries: ImportedEntries) => {
    setDraft((current) => {
      if (!current) return current;
      const result = mergeImportedEntries(current, entries, new Date().toISOString());
      setLastMerge({ added: result.added, skipped: result.skipped });
      return result.profile;
    });
  }, []);

  return {
    status,
    draft,
    dirty: draft !== null && snapshot(draft) !== baseline,
    saving,
    saveError,
    savedAt,
    loadError,
    unreadable,
    lastMerge,
    edit,
    save,
    startFresh,
    merge,
  };
}
