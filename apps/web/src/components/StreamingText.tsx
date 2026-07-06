import { memo } from "react";

// Memoized per-section delta sink (PLAN.md §6): sections stream serially, so
// exactly one caret is live; memoization keeps token-cadence re-renders from
// touching every other card (risk 15).

export const StreamingText = memo(function StreamingText({
  text,
  done,
}: {
  text: string;
  done: boolean;
}) {
  return (
    <p className="streaming-text">
      {text}
      {!done && <span className="caret" aria-hidden="true" />}
    </p>
  );
});
