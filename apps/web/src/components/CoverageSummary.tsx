import type { TierNumber, TierStatus } from "@/shared/schema";
import type { RunState } from "./runState";

// Coverage chips (PLAN.md §6): found solid / not_found hollow /
// skipped_budget dashed, plus the fetch tally and the budget.exhausted note.
// Chips land progressively — one per enrichment.tier.completed frame — and
// skips are first-class honest outcomes, not errors.

const TIER_NAMES: Record<TierNumber, string> = {
  0: "Listing",
  1: "Company site",
  2: "Blog & GitHub",
  3: "News",
};

const STATUS_COPY: Record<TierStatus, string> = {
  found: "found",
  not_found: "not found",
  skipped_budget: "skipped — budget",
};

const TIER_ORDER: TierNumber[] = [0, 1, 2, 3];

export function CoverageSummary({
  tiers,
  fetchesUsed,
  maxFetches,
  notice,
}: {
  tiers: RunState["tiers"];
  fetchesUsed?: number;
  maxFetches?: number;
  notice?: RunState["budgetNotice"];
}) {
  const present = TIER_ORDER.flatMap((tier) => {
    const coverage = tiers[tier];
    return coverage ? [{ tier, ...coverage }] : [];
  });
  if (present.length === 0) return null;
  const sourceCount = present.reduce((n, t) => n + t.sources.length, 0);

  return (
    <section className="card coverage" aria-label="Company research coverage">
      <h2 className="coverage-title">Coverage</h2>
      <ul className="coverage-chips">
        {present.map(({ tier, status }) => (
          <li key={tier} className={`tier-chip tier-${status}`}>
            <span className="tier-name">{TIER_NAMES[tier]}</span>
            <span className="tier-status">{STATUS_COPY[status]}</span>
          </li>
        ))}
      </ul>
      <p className="coverage-tally">
        {fetchesUsed !== undefined && maxFetches !== undefined && (
          <>
            {fetchesUsed}/{maxFetches} fetches ·{" "}
          </>
        )}
        {sourceCount} source{sourceCount === 1 ? "" : "s"} found
      </p>
      {notice && (
        <p className="coverage-notice">
          {notice.kind === "fetches"
            ? "Fetch budget spent"
            : "Run time budget reached"}
          {notice.skippedTiers.length > 0 && (
            <>
              {" "}
              — skipped{" "}
              {notice.skippedTiers
                .map((tier) => TIER_NAMES[tier as TierNumber] ?? `tier ${tier}`)
                .join(", ")}
            </>
          )}
          .
        </p>
      )}
    </section>
  );
}
