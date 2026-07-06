import type { Confidence } from "@/shared/schema";

// The briefing/hook confidence scale made visible (PLAN.md §6): high solid
// "grounded", low amber "listing-only", none gray "not found". Confidence is
// computed by domain code from coverage — this only renders it, and there is
// no render path that omits it. (Increment 8 adds the contact scale:
// verified / public / guess.)

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
