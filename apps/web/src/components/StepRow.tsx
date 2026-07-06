import type { FetchSkipReason } from "@/shared/schema";
import type { StepView } from "./runState";
import { SourceChip } from "./SourceCitations";

// Spinner -> check / muted skip (PLAN.md §6). Skips are first-class honest
// outcomes: every reason gets its own human label, exhaustively — adding a
// FetchSkipReason breaks this build until it has UI copy.

const SKIP_LABELS: Record<FetchSkipReason, string> = {
  robots_disallowed: "blocked by robots.txt",
  timeout: "timed out",
  http_status: "server returned an error",
  not_html: "not an HTML page",
  network: "host unreachable",
  too_large: "page too large",
  empty_content: "no readable text",
  circuit_open: "paused after repeated failures",
  budget_exhausted: "skipped — run budget spent",
  cancelled: "cancelled",
};

function skipLabel(step: StepView): string {
  if (!step.skip) return "skipped";
  const label = SKIP_LABELS[step.skip.reason];
  return step.skip.httpStatus !== undefined ? `${label} (HTTP ${step.skip.httpStatus})` : label;
}

export function StepRow({ step }: { step: StepView }) {
  return (
    <li className={`step-row step-${step.status}`}>
      <span className="step-icon" aria-hidden="true">
        {step.status === "running" ? (
          <span className="dot pulse" />
        ) : step.status === "ok" ? (
          "✓"
        ) : (
          "—"
        )}
      </span>
      <span className="step-label">{step.label}</span>
      {step.status === "skipped" && (
        // skip.detail is the taxonomy's honesty channel — a guessed URL that
        // failed the name match, or a redirect onto an already-cited page,
        // encodes as empty_content and explains itself here on hover, so the
        // terse reason label never stands alone as the only account.
        <span className="step-skip" title={step.skip?.detail}>
          {skipLabel(step)}
        </span>
      )}
      {step.status === "ok" && step.source && <SourceChip source={step.source} />}
      {step.cached && <span className="cached-tag">cached</span>}
    </li>
  );
}
