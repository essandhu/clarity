"use client";

import { useEffect, useRef, useState } from "react";
import {
  ContactResponseSchema,
  type ContactCandidate,
  type ContactResponse,
  type ContactSourceTried,
  type ListingProfile,
} from "@/shared/schema";
import { buildContactRequest } from "./contactRequest";
import { ContactCandidateCard } from "./ContactCandidateCard";
import type { RunState } from "./runState";
import { readErrorMessage } from "./sseClient";

// Opt-in Stage 4 (spec §3, decision 27): this panel mounts only after
// run.completed, and NO contact network fires before the button click —
// opt-in is structural, not a convention.

type PanelState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; response: ContactResponse }
  | { phase: "error"; message: string };

const TRIED_LABELS: Record<string, string> = {
  listing: "the listing",
  careers: "the careers page",
  github: "GitHub",
};

function triedSummary(tried: ContactSourceTried[]): string {
  if (tried.length === 0) return "No public sources were available to check.";
  const parts = tried.map((entry) => {
    const label = TRIED_LABELS[entry.id] ?? entry.id;
    return entry.status === "skipped" ? `${label} (skipped)` : label;
  });
  return `Checked ${parts.join(", ")} — no contact found.`;
}

export function ContactPanel({
  profile,
  tiers,
  selectedContact,
  onUseContact,
}: {
  profile: ListingProfile;
  tiers: RunState["tiers"];
  selectedContact: ContactCandidate | null;
  onUseContact: (candidate: ContactCandidate) => void;
}) {
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const search = () => {
    if (state.phase === "loading") return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const res = await fetch("/api/contact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildContactRequest(profile, tiers)),
          signal: controller.signal,
        });
        if (!res.ok) {
          setState({ phase: "error", message: await readErrorMessage(res) });
          return;
        }
        // The client re-validates the wire (the §6 transport rule).
        const parsed = ContactResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          setState({ phase: "error", message: "The contact response did not match the schema." });
          return;
        }
        setState({ phase: "done", response: parsed.data });
      } catch (err) {
        if (controller.signal.aborted) return; // unmounted — nothing to render
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

  return (
    <section className="card contact-panel" aria-label="Contact surfacing">
      <h2 className="section-heading">Contact</h2>
      {state.phase !== "done" && (
        <>
          <p className="contact-blurb">
            Optional: look for a person and channel to reach about this role. Nothing runs until
            you ask, and nothing is stored.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={search}
            disabled={state.phase === "loading"}
          >
            {state.phase === "loading" ? "Searching public sources…" : "Find a contact for this role"}
          </button>
        </>
      )}
      {state.phase === "error" && (
        <p className="error-hint" role="alert">
          {state.message}
        </p>
      )}
      {state.phase === "done" &&
        (state.response.candidates.length > 0 ? (
          <div className="contact-results">
            {state.response.candidates.map((candidate) => (
              <ContactCandidateCard
                key={`${candidate.channel}:${candidate.value ?? candidate.name ?? ""}`}
                candidate={candidate}
                selected={selectedContact === candidate}
                onUse={onUseContact}
              />
            ))}
          </div>
        ) : (
          <p className="contact-none">{triedSummary(state.response.sourcesTried)}</p>
        ))}
    </section>
  );
}
