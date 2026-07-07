// Increment 9 live proof (PLAN.md §7): drives /api/analyze over the real
// wire through the REAL parseSse + runReducer, timestamping every frame —
// run the same listing twice and compare enrichment wall-clock, cached tags,
// and run.completed.fetchCount.
//
//   cd apps/web && npx tsx scripts/try-cache.ts <listing-url> [base-url]
//
// Exits 0 on phase 'done', 1 otherwise; prints a JSON summary last.
import { createSseParser } from "../src/components/parseSse";
import { runReducer } from "../src/components/runReducer";
import { initialRunState, type RunState } from "../src/components/runState";
import { PipelineEventSchema } from "../src/shared/schema";

const args = process.argv.slice(2).filter((a) => a !== "--enrich-only");
// --enrich-only: abort (client-side, the proven §3 teardown) right after
// enrichment.completed — the cache proofs live entirely in Stages 1–2, and
// a CPU-Ollama synthesis costs hours that prove nothing about increment 9.
const enrichOnly = process.argv.includes("--enrich-only");
const url = args[0];
const base = args[1] ?? "http://localhost:3000";
if (!url) {
  console.error("usage: npx tsx scripts/try-cache.ts <listing-url> [base-url] [--enrich-only]");
  process.exit(1);
}

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  let state: RunState = runReducer(initialRunState, { type: "submit" });
  let enrichStartedAt: number | undefined;
  let enrichMs: number | undefined;
  let fetchCount: number | undefined;

  const controller = new AbortController();
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "url", url }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const parser = createSseParser();
  const reader = res.body.getReader();
  reading: for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (enrichOnly && controller.signal.aborted) break; // deliberate teardown
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    for (const frame of parser.push(value)) {
      if (enrichOnly && controller.signal.aborted) break reading;
      const event = PipelineEventSchema.parse(JSON.parse(frame.data));
      state = runReducer(state, { seq: Number(frame.id), event });
      if (event.type === "heartbeat") continue;
      if (event.type === "stage.started" && event.stage === "enrichment") {
        enrichStartedAt = Date.now();
      }
      if (event.type === "enrichment.completed") {
        if (enrichStartedAt !== undefined) enrichMs = Date.now() - enrichStartedAt;
        fetchCount = event.summary.fetchesUsed;
        console.log(`[${at()}] enrichment.completed fetchesUsed=${event.summary.fetchesUsed}`);
        if (enrichOnly) {
          state = runReducer(state, { type: "aborted" });
          controller.abort();
        }
        continue;
      }
      if (event.type === "run.completed") fetchCount = event.fetchCount;
      if (event.type === "synthesis.delta") continue; // too chatty to log
      const extra =
        event.type === "step.finished"
          ? ` ${event.stepId} ${event.status}${event.cached ? " CACHED" : ""}${
              event.skip ? ` (${event.skip.reason})` : ""
            }`
          : event.type === "enrichment.tier.completed"
            ? ` tier ${event.tier} ${event.status} (${event.sources.length} sources)`
            : event.type === "run.completed"
              ? ` fetchCount=${event.fetchCount} elapsedMs=${event.elapsedMs}`
              : event.type === "run.error"
                ? ` ${event.code}: ${event.message}`
                : "";
      console.log(`[${at()}] ${event.type}${extra}`);
    }
  }

  const summary = {
    phase: state.phase,
    enrichMs,
    fetchCount,
    fetchesUsed: state.fetchesUsed,
    cachedSteps: state.steps.filter((s) => s.cached).map((s) => s.stepId),
    okSteps: state.steps.filter((s) => s.status === "ok").length,
    skippedSteps: state.steps
      .filter((s) => s.status === "skipped")
      .map((s) => `${s.stepId}:${s.skip?.reason}`),
    openSteps: state.steps.filter((s) => s.status === "running").length,
    tiers: Object.fromEntries(
      Object.entries(state.tiers).map(([tier, t]) => [tier, t?.status]),
    ),
    sections: state.sectionOrder.map((id) => `${id}:${state.sections[id]?.confidence}`),
    hooks: state.hooks.length,
    fatal: state.fatal,
  };
  console.log("SUMMARY " + JSON.stringify(summary, null, 2));
  const ok = state.phase === "done" || (enrichOnly && state.phase === "cancelled");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
