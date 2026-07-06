import { useEffect, useState } from "react";
import type { Hook } from "@/shared/schema";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { SourceCitations } from "./SourceCitations";

// One card per surviving hook (PLAN.md §6): text, basis, badge, citations,
// copy. Hooks only exist cited (HookSchema.sources.min(1)) — there is no
// citation-free render path here.

export function HookCard({ hook }: { hook: Hook }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // navigator.clipboard is undefined outside secure contexts (e.g. plain
    // http over the LAN) — the optional chain short-circuits the whole call
    // there, and the catch covers permission denials: the button simply
    // never claims success.
    void navigator.clipboard
      ?.writeText(hook.text)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <article className="card hook-card">
      <div className="briefing-head">
        <p className="hook-text">{hook.text}</p>
        <ConfidenceBadge confidence={hook.confidence} />
      </div>
      <p className="hook-basis">{hook.basis}</p>
      <div className="hook-foot">
        <SourceCitations sources={hook.sources} />
        <button type="button" className="copy-button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </article>
  );
}
