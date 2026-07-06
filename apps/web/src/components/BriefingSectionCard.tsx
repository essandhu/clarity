import { memo } from "react";
import { ConfidenceBadge } from "./ConfidenceBadge";
import type { SectionView } from "./runState";
import { SourceCitations } from "./SourceCitations";
import { StreamingText } from "./StreamingText";

// One card per synthesis.section.started, mounted in arrival order (PLAN.md
// §6). Badge + citation chips render from the started frame — BEFORE any
// tokens — and section.completed swaps the streamed buffer for canonical
// content. Memoized so one section's token cadence never re-renders the rest
// (the reducer keeps untouched sections' object identity stable).

export const BriefingSectionCard = memo(function BriefingSectionCard({
  section,
}: {
  section: SectionView;
}) {
  return (
    <section className="card briefing-section" aria-label={section.title}>
      <header className="briefing-head">
        <h3>{section.title}</h3>
        <ConfidenceBadge confidence={section.confidence} />
      </header>
      <SourceCitations sources={section.sources} />
      <StreamingText text={section.text} done={section.done} />
    </section>
  );
});
