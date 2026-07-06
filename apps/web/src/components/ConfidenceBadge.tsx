import type { Confidence, ContactConfidence } from "@/shared/schema";

// Both confidence scales made visible (PLAN.md §6). Briefing/hooks: high
// solid "grounded", low amber "listing-only", none gray "not found".
// Contacts: verified / public solid, guess dashed with unmistakable
// "guessed — unverified" copy (§5: nothing labeled guess presented as fact).
// Confidence is computed by domain code — this only renders it, and there is
// no render path that omits it.

const COPY: Record<Confidence, string> = {
  high: "grounded",
  low: "listing-only",
  none: "not found",
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`confidence-badge confidence-${confidence}`}>{COPY[confidence]}</span>
  );
}

const CONTACT_COPY: Record<ContactConfidence, string> = {
  verified: "verified",
  public: "publicly listed",
  guess: "guessed — unverified",
};

export function ContactConfidenceBadge({ confidence }: { confidence: ContactConfidence }) {
  return (
    <span className={`confidence-badge contact-${confidence}`}>{CONTACT_COPY[confidence]}</span>
  );
}
