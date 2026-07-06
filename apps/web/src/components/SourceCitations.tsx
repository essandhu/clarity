import { PASTED_LISTING_URL, type SourceRef } from "@/shared/schema";

// SourceRef chips (PLAN.md §6): the ONE citation primitive — briefing
// sections, hooks, step rows (and increment 8's contacts) all compose it.
// External refs are links with a fetchedAt tooltip; the canonical
// 'listing:pasted' ref renders as a non-link chip with the same visual
// grammar, so the sparse paste path is cited, not citation-free.

function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function SourceChip({ source }: { source: SourceRef }) {
  if (source.url === PASTED_LISTING_URL) {
    return <span className="source-chip source-chip-pasted">{source.label}</span>;
  }
  return (
    <a
      className="source-chip"
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={`${source.label} — fetched ${source.fetchedAt}`}
    >
      {sourceHost(source.url)}
    </a>
  );
}

export function SourceCitations({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <ul className="source-citations" aria-label="Sources">
      {sources.map((source) => (
        <li key={source.url}>
          <SourceChip source={source} />
        </li>
      ))}
    </ul>
  );
}
