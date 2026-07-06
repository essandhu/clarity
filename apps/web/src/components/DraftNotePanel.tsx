"use client";

import { useEffect, useState } from "react";
import type { ContactCandidate, Hook, ListingProfile } from "@/shared/schema";
import { ContactConfidenceBadge } from "./ConfidenceBadge";
import { hasEmailValue, mailtoEmail, mailtoHref } from "./draftHandoff";
import { StreamingText } from "./StreamingText";
import { useDraftRun } from "./useDraftRun";

// The streamed draft note (PLAN.md §6): watch the note being written, then
// hand off to the user's own mail client — [Open in mail] / [Copy]; the app
// never sends. A 'guess' email enters the mailto target only after the
// explicit "use this guess" click (decision 28).

export function DraftNotePanel({
  profile,
  hooks,
  contact,
}: {
  profile: ListingProfile;
  hooks: Hook[];
  contact: ContactCandidate | null;
}) {
  const { state, start, cancel } = useDraftRun();
  // The accept click authorizes ONE specific guessed candidate, not guessing
  // in general — keyed by identity, so switching contacts revokes it without
  // any effect-driven reset.
  const [acceptedGuess, setAcceptedGuess] = useState<ContactCandidate | null>(null);
  const guessAccepted = contact !== null && acceptedGuess === contact;

  const streaming = state.phase === "streaming";
  const email = mailtoEmail(contact, guessAccepted);
  const needsGuessClick =
    contact !== null &&
    hasEmailValue(contact) &&
    contact.confidence === "guess" &&
    !guessAccepted;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    if (!state.note) return;
    void navigator.clipboard
      ?.writeText(state.note.body)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <section className="card draft-panel" aria-label="Draft outreach note">
      <h2 className="section-heading">Draft note</h2>
      {contact && (
        <p className="draft-recipient">
          To: {contact.name ?? contact.value}
          {contact.role ? ` — ${contact.role}` : ""}{" "}
          <ContactConfidenceBadge confidence={contact.confidence} />
        </p>
      )}
      <div className="draft-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => start({ profile, hooks, contact: contact ?? undefined })}
          disabled={streaming}
        >
          {streaming
            ? "Drafting…"
            : state.phase === "done"
              ? "Draft again"
              : "Draft outreach note"}
        </button>
        {streaming && (
          <button type="button" className="ghost-button" onClick={cancel}>
            Stop
          </button>
        )}
      </div>
      {(state.text || streaming) && <StreamingText text={state.text} done={!streaming} />}
      {state.phase === "error" && (
        <p className="error-hint" role="alert">
          {state.error}
        </p>
      )}
      {state.phase === "done" && state.note && (
        <div className="draft-actions">
          {needsGuessClick && (
            <button
              type="button"
              className="use-guess-button"
              onClick={() => setAcceptedGuess(contact)}
            >
              Use this guessed address
            </button>
          )}
          <a className="primary-button" href={mailtoHref(state.note, email)}>
            Open in mail{email ? "" : " (no address)"}
          </a>
          <button type="button" className="copy-button" onClick={copy}>
            {copied ? "Copied" : "Copy note"}
          </button>
        </div>
      )}
    </section>
  );
}
