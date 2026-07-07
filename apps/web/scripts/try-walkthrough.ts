// Increment 10 live proof (PLAN.md §7 / spec §10 definition of done): the
// keyless walkthrough chain — paste a listing → live streamed pipeline →
// honest cited briefing → opt-in contact → streamed draft note → mail-client
// hand-off — driven over the real wire through the REAL client machinery
// (parseSse + runReducer for the run, buildContactRequest for the opt-in
// click, draftReducer for the note, mailtoEmail/mailtoHref for the hand-off).
//
//   cd apps/web && npx tsx scripts/try-walkthrough.ts <listing-file> [base-url]
//
// Exits 0 only if every §10 link in the chain held; prints a JSON summary.
import { readFileSync } from "node:fs";
import { buildContactRequest } from "../src/components/contactRequest";
import { mailtoEmail, mailtoHref } from "../src/components/draftHandoff";
import { createSseParser } from "../src/components/parseSse";
import { runReducer } from "../src/components/runReducer";
import { initialRunState, type RunState } from "../src/components/runState";
import {
  draftReducer,
  initialDraftState,
  type DraftState,
} from "../src/components/useDraftRun";
import {
  ContactResponseSchema,
  PASTED_LISTING_URL,
  PipelineEventSchema,
  type ContactCandidate,
} from "../src/shared/schema";

const listingFile = process.argv[2];
const base = process.argv[3] ?? "http://localhost:3000";
if (!listingFile) {
  console.error("usage: npx tsx scripts/try-walkthrough.ts <listing-file> [base-url]");
  process.exit(1);
}
const text = readFileSync(listingFile, "utf8");

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  console.log(`[${at()}] ${ok ? "PASS" : "FAIL"} ${what}`);
};

async function health(): Promise<void> {
  const res = await fetch(`${base}/api/health`);
  const payload = (await res.json()) as {
    provider: { id: string; model?: string; reachable?: boolean };
  };
  console.log(`[${at()}] /api/health ${JSON.stringify(payload)}`);
  check(payload.provider.id === "ollama", "keyless: resolved provider is ollama");
  check(payload.provider.reachable === true, "Ollama reachable at configured base URL");
}

async function analyze(): Promise<RunState> {
  let state: RunState = runReducer(initialRunState, { type: "submit" });
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "text", text }),
  });
  if (!res.ok || !res.body) throw new Error(`analyze HTTP ${res.status}: ${await res.text()}`);

  const parser = createSseParser();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(value)) {
      const event = PipelineEventSchema.parse(JSON.parse(frame.data));
      state = runReducer(state, { seq: Number(frame.id), event });
      if (event.type === "heartbeat" || event.type === "synthesis.delta") continue;
      const extra =
        event.type === "step.finished"
          ? ` ${event.stepId} ${event.status}${event.skip ? ` (${event.skip.reason})` : ""}`
          : event.type === "enrichment.tier.completed"
            ? ` tier ${event.tier} ${event.status}`
            : event.type === "synthesis.section.started"
              ? ` ${event.sectionId} ${event.confidence} (${event.sources.length} sources)`
              : event.type === "run.error"
                ? ` ${event.code}: ${event.message}`
                : "";
      console.log(`[${at()}] ${event.type}${extra}`);
    }
  }
  return state;
}

async function contact(state: RunState): Promise<ContactCandidate | undefined> {
  if (!state.profile) throw new Error("no profile on completed run");
  // The opt-in click (spec §3): nothing contact-related ran before this POST.
  const res = await fetch(`${base}/api/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildContactRequest(state.profile, state.tiers)),
  });
  check(res.ok, `contact route answered (HTTP ${res.status})`);
  const payload = ContactResponseSchema.parse(await res.json());
  console.log(`[${at()}] /api/contact ${JSON.stringify(payload, null, 2)}`);
  check(
    payload.candidates.every((c) => c.confidence !== "verified"),
    "no candidate claims 'verified' (v1 never does)",
  );
  return payload.candidates[0];
}

async function draft(state: RunState, candidate: ContactCandidate | undefined): Promise<void> {
  if (!state.profile) throw new Error("no profile on completed run");
  let draftState: DraftState = draftReducer(initialDraftState, { type: "submit" });
  let deltas = 0;
  let firstFrameSeq: number | undefined;
  const res = await fetch(`${base}/api/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profile: state.profile,
      hooks: state.hooks,
      ...(candidate ? { contact: candidate } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`draft HTTP ${res.status}: ${await res.text()}`);
  const parser = createSseParser();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(value)) {
      const event = PipelineEventSchema.parse(JSON.parse(frame.data));
      firstFrameSeq ??= Number(frame.id);
      draftState = draftReducer(draftState, { seq: Number(frame.id), event });
      if (event.type === "draft.delta") deltas += 1;
      else if (event.type !== "heartbeat") console.log(`[${at()}] ${event.type}`);
    }
  }
  check(firstFrameSeq === 0, "draft.started arrived at seq 0");
  check(draftState.phase === "done" && !!draftState.note, "draft stream completed with a note");
  console.log(`[${at()}] draft deltas=${deltas}`);
  const note = draftState.note;
  if (!note) return;
  const offered = new Set(state.hooks.map((h) => h.text));
  check(
    note.groundedHooks.every((h) => offered.has(h)),
    "groundedHooks are a verbatim subset of the offered hooks",
  );
  check(
    note.subject === `${state.profile.role} at ${state.profile.company}`,
    "subject is mechanical (role at company)",
  );
  // The hand-off (spec §7: the app drafts, the USER sends). A guess address
  // enters the mailto only via the explicit accept, which we exercise here.
  const accepted = candidate?.confidence === "guess";
  const email = mailtoEmail(candidate, accepted);
  const href = mailtoHref(note, email);
  console.log(`[${at()}] mailto href (${email ? "recipient set" : "no recipient"}):`);
  console.log(href.length > 400 ? `${href.slice(0, 400)}…` : href);
  console.log(`[${at()}] draft note body:\n${note.body}`);
}

async function main(): Promise<void> {
  await health();
  const state = await analyze();
  check(state.phase === "done", `run reached phase done (got '${state.phase}')`);
  check(
    state.steps.every((s) => s.status !== "running"),
    "zero open steps after the terminal frame",
  );
  const sections = state.sectionOrder.map((id) => {
    const s = state.sections[id];
    return {
      id,
      confidence: s?.confidence,
      sources: s?.sources.map((r) => r.label) ?? [],
      citesPasted: s?.sources.some((r) => r.url === PASTED_LISTING_URL) ?? false,
    };
  });
  console.log(`[${at()}] sections ${JSON.stringify(sections, null, 2)}`);
  check(
    sections.some((s) => s.citesPasted),
    'paste run cites the non-link "Pasted listing text" ref',
  );
  check(
    sections.every((s) => s.confidence === "none" || s.sources.length > 0),
    "every non-none section carries at least one citation",
  );
  console.log(
    `[${at()}] hooks ${JSON.stringify(
      state.hooks.map((h) => ({ text: h.text, sources: h.sources.map((r) => r.label) })),
      null,
      2,
    )}`,
  );
  const candidate = await contact(state);
  await draft(state, candidate);

  console.log(
    "SUMMARY " +
      JSON.stringify(
        {
          phase: state.phase,
          fetchesUsed: state.fetchesUsed,
          tiers: Object.fromEntries(
            Object.entries(state.tiers).map(([tier, t]) => [tier, t?.status]),
          ),
          sections: sections.map((s) => `${s.id}:${s.confidence}`),
          hooks: state.hooks.length,
          failures,
        },
        null,
        2,
      ),
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
