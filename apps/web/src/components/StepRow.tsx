import { PASTED_LISTING_URL, type FetchSkipReason } from "@/shared/schema";
import type { StepView } from "./runState";

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

function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
      {step.status === "skipped" && <span className="step-skip">{skipLabel(step)}</span>}
      {step.status === "ok" &&
        step.source &&
        (step.source.url === PASTED_LISTING_URL ? (
          <span className="source-chip source-chip-pasted">{step.source.label}</span>
        ) : (
          <a
            className="source-chip"
            href={step.source.url}
            target="_blank"
            rel="noreferrer"
            title={`Fetched ${step.source.fetchedAt}`}
          >
            {sourceHost(step.source.url)}
          </a>
        ))}
      {step.cached && <span className="cached-tag">cached</span>}
    </li>
  );
}
