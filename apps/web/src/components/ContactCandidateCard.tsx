import type { ContactCandidate, ContactChannel } from "@/shared/schema";
import { ContactConfidenceBadge } from "./ConfidenceBadge";
import { SourceChip } from "./SourceCitations";

// One card per contact candidate (PLAN.md §6): channel, name/role, value,
// badge, citation. A 'guess' is styled dashed and its badge says so — there
// is no render path that presents a guess as fact (§5). The exhaustive
// channel-copy map is the convention: a new channel is a compile error here.

const CHANNEL_LABELS: Record<ContactChannel, string> = {
  listing: "From the listing",
  careers: "Careers page",
  github: "GitHub",
  linkedin: "LinkedIn — right channel",
  "inferred-email": "Guessed email pattern",
};

export function ContactCandidateCard({
  candidate,
  selected,
  onUse,
}: {
  candidate: ContactCandidate;
  selected: boolean;
  onUse: (candidate: ContactCandidate) => void;
}) {
  const isLink = candidate.channel === "linkedin" && /^https:\/\//.test(candidate.value ?? "");
  return (
    <article
      className={`card contact-card${candidate.confidence === "guess" ? " contact-card-guess" : ""}`}
      aria-label={CHANNEL_LABELS[candidate.channel]}
    >
      <div className="contact-head">
        <span className="contact-channel">{CHANNEL_LABELS[candidate.channel]}</span>
        <ContactConfidenceBadge confidence={candidate.confidence} />
      </div>
      {(candidate.name || candidate.role) && (
        <p className="contact-person">
          {candidate.name}
          {candidate.name && candidate.role ? " — " : ""}
          {candidate.role}
        </p>
      )}
      {candidate.value &&
        (isLink ? (
          <a className="contact-value" href={candidate.value} target="_blank" rel="noreferrer">
            Search on LinkedIn
          </a>
        ) : (
          <p className="contact-value">{candidate.value}</p>
        ))}
      <div className="contact-foot">
        <SourceChip source={candidate.source} />
        <button
          type="button"
          className="copy-button"
          aria-pressed={selected}
          onClick={() => onUse(candidate)}
        >
          {selected ? "Selected for draft" : "Use for draft"}
        </button>
      </div>
    </article>
  );
}
