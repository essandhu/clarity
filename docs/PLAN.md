# Clarity v1 — Final Implementation Plan

This is the authoritative implementation plan, synthesized from the winning INCREMENTAL DELIVERY plan, with every judge-flagged improvement grafted in and every flagged flaw fixed. `clarity-v1-spec.md` remains the source of truth; where this plan is more specific, this plan governs. **Documented deviations from the spec are called out explicitly where they occur (see decision 15) and are restated in the README — never silent.**

---

## 1. Key architectural decisions

Each decision, with one-line rationale. Exact package versions come from the verified research briefs (mid-2026), not training data.

1. **Layout: literal `apps/web` per spec §2, as a plain single npm package** — honors the spec diagram exactly with zero monorepo tooling; a future `packages/` split stays mechanical.
2. **Node 24 (Active LTS), `engines: ">=22"`** — `ai@7` and `cockatiel@4` both require Node ≥ 22; 24 is the recommended LTS target.
3. **Next.js `next@^16.2.10`, App Router, TypeScript strict** — current LTS line; route handlers declare `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` (jsdom needs Node; prevents static optimization of stream routes).
4. **Transport: SSE frames over a streamed POST `fetch`** — spec §2 literally annotates `/api/analyze` as SSE; POST-with-fetch (not `EventSource`, which cannot POST or abort) gives request bodies plus AbortController cancellation.
5. **Model layer: `ai@^7.0.14` + `@ai-sdk/openai@^4.0.7` + `@ai-sdk/anthropic@^4.0.7` + `ai-sdk-ollama@^4.0.0`** — one AI SDK code path with an env switch satisfies §4.1's "do not write three clients"; `ai-sdk-ollama` uses Ollama's *native* JSON-schema-constrained `format` param, which is materially more reliable than the `/v1` OpenAI-compat shim for structured output on small local models.
6. **`extract()` = `generateText` + `Output.object({ schema })`, never `generateObject`** — `generateObject`/`streamObject` are deprecated since AI SDK v6 and slated for removal; on `NoObjectGeneratedError` we perform exactly one explicit repair re-prompt (feeding back `err.text` + the ZodError) because the SDK's `maxRetries` covers API errors only, not validation failures.
7. **`streamSynthesis()` = `streamText(...).textStream`** — already typed `AsyncIterable<string>`, satisfying §4.1 verbatim with zero adapter code.
8. **Zod `^4` project-wide; all shapes (including the wire protocol) live in `src/shared/schema/` with types via `z.infer`** — one schema is emitted by the domain, serialized by the SSE adapter, and re-validated by the client reducer, so protocol drift is a failing test, not a rendering bug.
9. **OpenAI strict-mode compatibility: `providerOptions.openai.strictJsonSchema: false` on extraction calls** — AI SDK 6+ defaults strict mode on, which rejects zod `.optional()` fields; one provider option keeps the §5 schemas canonical instead of maintaining nullable extraction variants.
10. **Fetcher resilience: `cockatiel@4.0.0`, composed `wrap(circuitBreaker, retry, timeout)`** — breaker (ConsecutiveBreaker(5), per-origin, halfOpenAfter 30s) counts one failure per exhausted retry sequence; timeout (`TimeoutStrategy.Aggressive`, clamped to the BudgetToken) bounds each attempt; the `{ signal }` from `execute()` is always threaded into `fetch` so aborts actually kill requests.
11. **Per-host rate limiting: `bottleneck@2.19.5` `Group` (`minTime: 1000`, `maxConcurrent: 2`), placed *inside* `policy.execute()`** — spec's library-first rule forbids hand-rolling; inside placement means retry attempts also queue behind the politeness delay; `Crawl-delay` from robots.txt raises that host's `minTime`.
12. **Robots: `robots-parser@3.0.1`, per-origin cache on a `globalThis` singleton** — handles the `isAllowed() === undefined` cross-origin footgun explicitly (`!== false` after same-origin check); 404 robots ⇒ allow, 5xx/unreachable ⇒ conservative typed skip; `globalThis` keying survives Next dev-mode HMR.
13. **Cleaning: `@mozilla/readability@0.6.0` (pinned exact) + `jsdom@^29.1.1`, with a `cheerio@^1.2.0` fallback strip** — `isProbablyReaderable` routes between them; Readability returns `null` on thin pages (the *common* case for sparse careers pages), so the cheerio path is mandatory, not optional; `dom.window.close()` in `finally` prevents window-graph leaks.
14. **Cache: flat JSON files (`data/cache/pages/{sha256(url)}.json`), no `better-sqlite3`** — spec explicitly permits flat files; removes the only native-module risk for "clone and run for free" users on odd Node versions; kept behind a `PageCache` interface so SQLite can be swapped in later.
15. **Wall-clock deadline bounds *fetching only* (Stages 1–2); synthesis runs under the user's cancel signal plus a per-stream inactivity watchdog** — otherwise slow CPU-Ollama synthesis self-cancels and the §10 keyless definition-of-done fails (graft from STREAMING UX FIRST, adopted as design, not a risk note). **This is a documented deviation from spec §3's "a run budget … bounds the whole thing"**, recorded here and in the README. The residual hole (a hung cloud stream or stuck Stage-1 extract with no upper bound if the user walks away) is closed by an **inactivity watchdog on every model call**: if no delta/completion progress arrives for `CLARITY_MODEL_INACTIVITY_MS` (default 300 000 ms — generous enough for CPU Ollama), the call is aborted and the run terminates with `run.error { code: 'INTERNAL', hint: 'The model stream stalled — check that Ollama is running / your provider status page.' }`. Total wall time is thus bounded by deadline + (sections × inactivity window) even with nobody watching; heartbeats are a liveness signal, not the safety mechanism.
16. **Zero-source briefing sections emit canned "Not found in available sources." with NO model call** — "never fabricates" enforced structurally; confidence is computed deterministically from coverage by domain code, never self-reported by the model, and lands in `synthesis.section.started` so the badge renders before the first token.
17. **Per-section serial model streams (no sentinel/marker parsing)** — each section's prompt contains only that section's own source excerpts (grounding by construction), and this eliminates the `@@SECTION@@`-parser fragility both losing plans admitted was their biggest risk on small Ollama models.
18. **Hooks via structured `extract()` with post-parse citation validation** — any hook citing a URL that was never actually fetched (or isn't the canonical pasted-listing ref, decision 33) is dropped; hook extraction is covered by its own `step.started`/`step.finished` pair so the timeline never goes dark (fixes the winner's dead-air flaw).
19. **Extracted page text stays OFF the wire** — events carry `SourceRef`s and counts only (graft from DOMAIN PURITY); `/api/contact` takes `{ profile, coverage }` (SourceRefs only) and re-reads pages through the cache-backed PageFetcher instead of round-tripping enrichment blobs.
20. **Tier-2 candidates (GitHub org, blog, changelog) are discovered from links found on Tier-1 pages**, with domain-slug guessing only as a fallback that requires a loose company-name match on the fetched page — largely eliminates the wrong-org fabrication risk (graft from STREAMING UX FIRST, promoted from risk list to design).
21. **Skips and fatal errors are disjoint by type** — `FetchSkip` (10 reasons, returned, never thrown) flows into coverage; `PipelineError` (4 codes, thrown once) is the only thing that terminates a run; Stages 2–3 are structurally incapable of killing a run.
22. **Clock is injected** — `RunBudget` takes a `Clock` so budget-deadline tests jump a fake clock instead of sleeping (graft from DOMAIN PURITY).
23. **ESLint `no-restricted-imports` layering rule + `satisfies never` exhaustive switches** — `src/domain/**` cannot import `next`/`ai`/`jsdom`/`cockatiel`/`node:fs`; extending `FetchSkipReason` or `PipelineEvent` breaks the build until every surface handles it (graft from DOMAIN PURITY).
24. **`heartbeat` SSE frame every 10s during long model calls; `id:` carries a monotonic `seq` the client dedups on; stream-close-without-terminal-event transitions the UI out of `running`** — the UI can never hang on a silent wire (grafts from STREAMING UX FIRST + DOMAIN PURITY).
25. **`/api/draft` streams** (`draft.started/delta/completed` over the same SSE envelope) — the draft is a synthesis surface the user watches being written; plain JSON next to a streamed briefing was a flagged downgrade.
26. **Tiny `GET /api/health`** — reports which provider is configured; when Ollama is selected it pings the **configured `OLLAMA_BASE_URL`** (defaulting to `http://localhost:11434`), read through the same composition-root env parsing that `createModelProvider` uses, so a non-default host/port never produces a false "unreachable" chip. Drives the UI provider chip ("Claude · your key" / "Ollama · local") without leaking keys; directly serves §4's "clear error" degradation.
27. **Stage 4 and the draft note live outside `runAnalysis` entirely** — separate user-initiated routes; the "Find a contact" button renders only after `run.completed`, making opt-in structural (spec §3/§6); contact results are never persisted and phone-shaped strings are stripped (§7).
28. **Guessed emails require an explicit "use this guess" click before entering a `mailto:` target** — §5's "nothing labeled guess presented as fact" made mechanical in the UI.
29. **Fetched page text is framed as untrusted quoted material in every synthesis prompt** — cheap prompt-injection mitigation (graft from DOMAIN PURITY).
30. **Recommended local models documented and smoke-tested: `qwen3:4b` (default; strip/disable `<think>` blocks), `llama3.2:3b`, `phi4-mini:3.8b`** — extraction at temperature 0 with schema-constrained decoding; the README names known-good tags so the §10 keyless walkthrough is reproducible.
31. **Plain CSS custom properties, no Tailwind/component library** — the §8 showpieces are behavioral; ~200 lines of CSS covers cards, chips, and pulse keyframes with the fewest moving parts.
32. **`SearchProvider` ships as an interface file referenced by nothing** — the exact seam the spec's free-search note requires, at zero speculative cost.
33. **Pasted listings carry a canonical synthetic `SourceRef`** — `SourceRefSchema.url` is `z.union([z.url(), z.literal('listing:pasted')])`; for `{ kind: 'text' }` input nothing is fetched, so the schema layer (increment 1) exports `PASTED_LISTING_URL = 'listing:pasted'` and a `pastedListingRef(submittedAt)` factory producing `{ url: 'listing:pasted', label: 'Pasted listing text', fetchedAt: <submission time> }`. Tier 0 for text input records `found` with `sources: [pastedListingRef]`; `low`-confidence sections (listing-only support), listing-grounded hooks, and `channel: 'listing'` contact candidates all cite it — every "sources non-empty" invariant (`Hook.sources.min(1)`, `ContactCandidate.source` mandatory, low sections cited) is zod-satisfiable on the sparse-20-person-startup paste path the spec's §1.3 and §10 walkthrough exercise. `SourceCitations` renders it as a **non-link chip**.

---

## 2. Complete file tree

Every file honors the spec's ~200-line ceiling; anything at risk is pre-split.

```
clarity/
├── clarity-v1-spec.md                        # the spec (kept; seeds README in increment 10)
├── README.md                                 # increment 10: setup, BYO-key vs Ollama tradeoff, privacy posture,
│                                             #   documented spec deviation (decision 15)
├── .gitignore                                # node_modules, .next, .env.local, apps/web/data/
└── apps/web/
    ├── package.json                          # engines >=22; deps pinned per §1 decisions
    ├── next.config.ts                        # serverExternalPackages: ['jsdom'], compress: false (dev streaming)
    ├── tsconfig.json                         # strict; paths "@/*" -> "./src/*"
    ├── eslint.config.mjs                     # layering rule: domain/** may not import vendors/fs/next
    ├── vitest.config.ts                      # unit tests for pure domain + client code
    ├── .env.example                          # MODEL_PROVIDER, OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL,
    │                                         #   OLLAMA_MODEL, CLARITY_MAX_FETCHES, CLARITY_DEADLINE_MS,
    │                                         #   CLARITY_MODEL_INACTIVITY_MS
    ├── app/
    │   ├── layout.tsx                        # root layout, globals.css import
    │   ├── globals.css                       # CSS custom-property tokens: stage colors, confidence colors, pulse
    │   ├── page.tsx                          # server component shell; renders <AnalyzeView/>
    │   └── api/
    │       ├── analyze/route.ts              # POST: zod-parse body -> runAnalysis -> SSE stream; abort wiring
    │       ├── contact/route.ts              # POST: opt-in Stage 4 -> { candidates, sourcesTried } JSON
    │       ├── draft/route.ts                # POST: streamed draft note (draft.* SSE events)
    │       └── health/route.ts               # GET: configured provider id + Ollama reachability (configured
    │                                         #   OLLAMA_BASE_URL via composition root); never leaks keys
    ├── src/
    │   ├── shared/schema/                    # zod = single source of truth; TS types via z.infer
    │   │   ├── sourceRef.ts                  # SourceRefSchema + PASTED_LISTING_URL + pastedListingRef factory
    │   │   ├── listingProfile.ts             # ListingProfileSchema (§5)
    │   │   ├── fetch.ts                      # CleanPageSchema, FetchSkipSchema (url optional) + 10-reason taxonomy
    │   │   ├── enrichment.ts                 # TierStatus, TierCoverage, EnrichmentResult, wire summary
    │   │   ├── briefing.ts                   # Confidence, BriefingSection, Briefing, SECTION_PLAN const
    │   │   ├── hook.ts                       # HookSchema
    │   │   ├── contact.ts                    # ContactCandidateSchema, contact request/response shapes
    │   │   ├── draftNote.ts                  # DraftNoteSchema, draft request shape
    │   │   ├── analyzeInput.ts               # AnalyzeInputSchema ({kind:'url'|'text'})
    │   │   ├── events.ts                     # PipelineEventSchema discriminated union (the wire protocol)
    │   │   └── index.ts                      # barrel re-exports
    │   ├── domain/
    │   │   ├── pipeline/
    │   │   │   ├── AnalysisPipeline.ts       # runAnalysis(input, deps, emit, signals): Stages 1-3 orchestration
    │   │   │   ├── RunBudget.ts              # createRunBudget: fetch counter, deadline, BudgetToken, tier pre-check
    │   │   │   ├── RunBudget.test.ts         # exhaustion + fake-clock deadline tests
    │   │   │   ├── clock.ts                  # Clock interface { now(): number } + systemClock
    │   │   │   └── errors.ts                 # PipelineError + 4 fatal codes + type guards
    │   │   ├── listing/
    │   │   │   ├── ListingExtractor.ts       # Stage 1: (url|text) -> fetch/clean -> extract -> ListingProfile
    │   │   │   ├── domainDeriver.ts          # company domain from URL/contact email; job-board denylist
    │   │   │   └── domainDeriver.test.ts     # greenhouse/lever/ashby hosts never treated as company domain
    │   │   ├── enrichment/
    │   │   │   ├── CompanyEnricher.ts        # Stage 2: tier loop, parallel budgeted fetches, step events
    │   │   │   ├── candidateUrls.ts          # Tier-1 derivation from domain (pure)
    │   │   │   ├── candidateUrls.test.ts     # tier derivation unit tests
    │   │   │   ├── linkDiscovery.ts          # Tier-2/3 candidates mined from links on fetched Tier-1 pages
    │   │   │   ├── linkDiscovery.test.ts     # github/blog/changelog link extraction tests
    │   │   │   └── coverage.ts               # fold fetch outcomes -> tier statuses + wire summary
    │   │   ├── synthesis/
    │   │   │   ├── BriefingSynthesizer.ts    # fixed section plan; deterministic confidence; serial streams
    │   │   │   ├── confidenceRules.ts        # coverage -> 'high'|'low'|'none' per section (pure, tested)
    │   │   │   ├── HookSynthesizer.ts        # extract() -> <=3 hooks; drops hooks citing unfetched URLs
    │   │   │   ├── NoteDrafter.ts            # (profile, hooks, contact?) -> streamed DraftNote; subset check
    │   │   │   └── prompts.ts                # all templates; untrusted-source framing; grounded-only rules
    │   │   └── contact/
    │   │       ├── ContactSurfacer.ts        # Stage 4: run sources, rank, dedupe, cap 5, strip phone shapes
    │   │       └── emailPattern.ts           # first.last@/first@/flast@ inference; always 'guess'; pure
    │   ├── providers/
    │   │   ├── model/
    │   │   │   ├── ModelProvider.ts          # interface (§4.1) + GenOpts + SynthesisPrompt (types only)
    │   │   │   ├── createModelProvider.ts    # env switch openai|anthropic|ollama; MODEL_UNCONFIGURED w/ hint
    │   │   │   ├── extractWithRepair.ts      # generateText+Output.object; one repair re-prompt on NoObjectGeneratedError
    │   │   │   ├── inactivityWatchdog.ts     # wraps extract/stream calls; aborts after CLARITY_MODEL_INACTIVITY_MS
    │   │   │   │                             #   without progress (decision 15)
    │   │   │   └── FakeModelProvider.ts      # scripted extract/stream results for tests + offline dev
    │   │   ├── fetch/
    │   │   │   ├── PageFetcher.ts            # interface (§4.2): fetchClean -> CleanPage | FetchSkip (types only)
    │   │   │   ├── RobotsAwarePageFetcher.ts # gate order: cache -> robots -> limiter -> policy -> clean
    │   │   │   ├── robotsGate.ts             # robots-parser; per-origin cache on globalThis; crawl-delay
    │   │   │   ├── hostRateLimiter.ts        # Bottleneck.Group keyed by host, on globalThis
    │   │   │   ├── resilience.ts             # cockatiel wrap(breaker, retry, timeout) factory; skip mapping
    │   │   │   ├── readabilityClean.ts       # jsdom+Readability, window.close in finally, soft-404 heuristic
    │   │   │   ├── cheerioStrip.ts           # fallback text strip for non-readerable pages
    │   │   │   └── FakePageFetcher.ts        # Map<url, CleanPage|FetchSkip> + call log for budget tests
    │   │   ├── contact/
    │   │   │   ├── ContactSource.ts          # interface (§4.3, types only)
    │   │   │   ├── PublicSourceContactSurfacer.ts # listing/careers contacts + github signal + inferred emails
    │   │   │   └── githubSignal.ts           # public org page via PageFetcher; requires name loose-match
    │   │   ├── search/
    │   │   │   └── SearchProvider.ts         # interface ONLY — the future-search seam; no implementation
    │   │   └── cache/
    │   │       ├── PageCache.ts              # get/set interface, 24h TTL contract
    │   │       └── JsonFilePageCache.ts      # data/cache/pages/{sha256(url)}.json; corrupt file = miss
    │   ├── server/
    │   │   ├── deps.ts                       # composition root: build { model, fetcher, cache, clock } from env;
    │   │   │                                 #   single place OLLAMA_BASE_URL is read (health + provider)
    │   │   └── sse.ts                        # PipelineEvent -> SSE frame encoder; ReadableStream + heartbeat timer
    │   └── components/
    │       ├── AnalyzeView.tsx               # top-level client component; wires hook -> children
    │       ├── useAnalysisRun.ts             # fetch-stream lifecycle + useReducer + abort()
    │       ├── parseSse.ts                   # incremental frame parser (buffers partial frames across chunks)
    │       ├── parseSse.test.ts              # chunk-boundary torture tests (frames split mid-byte)
    │       ├── runReducer.ts                 # pure: (RunState, PipelineEvent|LocalAction) -> RunState
    │       ├── runReducer.test.ts            # replays recorded .jsonl event fixtures
    │       ├── ListingInputForm.tsx          # URL/paste toggle, provider chip (from /api/health), submit
    │       ├── AgentStepTimeline.tsx         # live agent-step visualization grouped by stage (§8 showpiece)
    │       ├── StepRow.tsx                   # spinner -> check/skip icon; exhaustive skip-reason labels
    │       ├── ProfileCard.tsx               # ListingProfile summary at extraction.completed
    │       ├── CoverageSummary.tsx           # tier chips: found / not_found / skipped_budget + fetch tally
    │       ├── BriefingSectionCard.tsx       # badge + citations up front, streaming body
    │       ├── StreamingText.tsx             # memoized per-section delta append with caret
    │       ├── HookCard.tsx                  # hook text + basis + badge + citations + copy
    │       ├── ConfidenceBadge.tsx           # high/low/none + verified/public/guess visual grammar
    │       ├── SourceCitations.tsx           # SourceRef chips; external links w/ fetchedAt tooltip;
    │       │                                 #   'listing:pasted' renders as a non-link chip
    │       ├── CancelButton.tsx              # aborts the in-flight run
    │       ├── ContactPanel.tsx              # opt-in button (post-run only) -> /api/contact
    │       ├── ContactCandidateCard.tsx      # channel/name/value + confidence; guess never styled as fact
    │       └── DraftNotePanel.tsx            # streamed draft; mailto: + copy; guess-email click-through
    ├── scripts/
    │   ├── try-model.ts                      # increment 2 proof: extract() + streamSynthesis() smoke (tsx)
    │   ├── try-fetch.ts                      # increment 3 proof: real URL, robots-blocked URL, budget skip
    │   └── try-extract.ts                    # increment 4 proof: fixture text + live URL -> ListingProfile
    ├── fixtures/
    │   ├── listings/                         # greenhouse-style, lever-style, sparse-startup listing texts
    │   └── event-streams/                    # recorded PipelineEvent .jsonl sequences for reducer tests
    └── data/                                 # local cache, gitignored; pages/ created lazily (increment 9)
```

---

## 3. Streamed pipeline event protocol

### Transport

Client: `fetch('/api/analyze', { method: 'POST', body: JSON.stringify(input), signal })`. Server responds with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`; the route exports `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, and returns the `Response` immediately (all looping happens inside the `ReadableStream.start()`). Each frame:

```
id: <monotonic integer seq, per run>
event: <type>
data: <JSON payload>
```

The payload union `PipelineEventSchema` (see §5) is the same zod type the domain emits, the SSE adapter serializes, and the client reducer re-parses — one schema, no drift. The client drops frames with `seq <= lastSeq`.

### Event catalog

| event | payload (TypeScript) | notes |
|---|---|---|
| `run.started` | `{ runId: string; provider: { id: string }; budget: { maxFetches: number; deadlineMs: number }; input: { kind: 'url' \| 'text' } }` | always first (seq 0) |
| `heartbeat` | `{}` | every 10s during long model calls; exempt from ordering rules; client ignores except liveness |
| `stage.started` | `{ stage: 'extraction' \| 'enrichment' \| 'synthesis' }` | stages strictly sequential |
| `step.started` | `{ stepId: string; stage: Stage; label: string; url?: string; tier?: 0\|1\|2\|3 }` | one per discrete action, incl. "Finding outreach hooks…" |
| `step.finished` | `{ stepId: string; status: 'ok' \| 'skipped'; skip?: FetchSkip; source?: SourceRef; cached?: boolean }` | exactly one per `step.started` (see ordering guarantee 3 for the client-abort exception); `skip.reason` carries the full taxonomy; `skip.url` is present on fetcher-produced skips, absent on non-fetch step skips (e.g. a cancelled hooks/synthesis step) |
| `extraction.completed` | `{ profile: ListingProfile }` | ends Stage 1; ProfileCard renders now (`rawText` capped at 20k chars) |
| `enrichment.tier.completed` | `{ tier: 0\|1\|2\|3; status: 'found' \| 'not_found' \| 'skipped_budget'; sources: SourceRef[] }` | coverage chips flip live; SourceRefs only, never page text; for text input, Tier 0 carries `[pastedListingRef]` |
| `budget.exhausted` | `{ kind: 'fetches' \| 'wall_clock'; fetchesUsed: number; elapsedMs: number; skippedTiers: number[] }` | informational, at most once per kind; the run continues to synthesis |
| `enrichment.completed` | `{ summary: { tiers: { tier: number; status: TierStatus; sourceCount: number }[]; fetchesUsed: number } }` | ends Stage 2; counts only — per-tier `SourceRef[]` already arrived via `enrichment.tier.completed`, and extracted text stays server-side |
| `synthesis.section.started` | `{ sectionId: string; title: string; confidence: 'high' \| 'low' \| 'none'; sources: SourceRef[] }` | confidence + citations computed deterministically from coverage, so badge + chips render **before** any tokens; `low` sections always cite at least the listing ref (real or pasted) |
| `synthesis.delta` | `{ sectionId: string; text: string }` | token chunks; only ever between that section's started/completed |
| `synthesis.section.completed` | `{ section: BriefingSection }` | canonical content replaces the streamed buffer |
| `synthesis.hooks.completed` | `{ hooks: Hook[] }` | after all sections; preceded by its own step pair; `[]` is a legal outcome |
| `run.completed` | `{ runId: string; elapsedMs: number; fetchCount: number }` | terminal (success) |
| `run.error` | `{ code: 'INPUT_INVALID' \| 'MODEL_UNCONFIGURED' \| 'EXTRACTION_FAILED' \| 'INTERNAL'; message: string; hint?: string; stage?: string }` | terminal (fatal only — a dead careers page is never a `run.error`); `hint` is actionable ("Set ANTHROPIC_API_KEY, or run Ollama and set MODEL_PROVIDER=ollama"; on a listing-URL fetch skip: "paste the listing text instead"; on a watchdog-aborted stalled model stream: "the model stream stalled — check Ollama / provider status") |

### Ordering guarantees

1. `run.started` is always seq 0; exactly one terminal event (`run.completed` XOR `run.error`) unless the client aborted.
2. Stages are strictly sequential: all `extraction` events precede `stage.started(enrichment)`, etc.
3. Within enrichment, `step.*` events from parallel fetches interleave freely, and each `stepId`'s `started` precedes its `finished`. The **step-pairing guarantee is scoped to server-side terminals**: on `run.error` and on deadline-driven teardown, every outstanding step is paired with `step.finished { status: 'skipped', skip: { reason: 'cancelled' } }` *before* the terminal frame, so no spinner can outlive a live stream. On **client-initiated abort** the connection is dead by definition — the server attempts no pairing frames; instead the client reducer's local `aborted` action authoritatively marks all in-flight steps cancelled. The SSE-adapter tests assert server-side pairing on `run.error`; the reducer tests assert the `aborted` action closes every open step.
4. Briefing sections stream serially (one model stream at a time); deltas for section N never interleave with section M.
5. `synthesis.hooks.completed` follows the last `synthesis.section.completed`.
6. `heartbeat` may appear anywhere after `run.started`.

### Skips, errors, cancellation on the wire

- **Skips are data, not errors**: `step.finished { status: 'skipped', skip: { reason: 'robots_disallowed' | 'timeout' | 'http_status' | 'not_html' | 'network' | 'too_large' | 'empty_content' | 'circuit_open' | 'budget_exhausted' | 'cancelled', url?, detail?, httpStatus? } }`, reflected in `enrichment.tier.completed.status`. Fetcher-produced skips always carry `url`; pipeline-produced skips on non-fetch steps (a cancelled "Finding outreach hooks…" or synthesis step) carry no `url` — `FetchSkipSchema.url` is optional so these frames parse. The run continues. Budget exhaustion is degradation (`budget.exhausted` + `skipped_budget` tiers + a normal `run.completed`), never a cancelled/terminal state.
- **Fatal errors** end the stream with `run.error` then close (outstanding steps paired first, per guarantee 3). Only four codes exist. Pre-stream body-validation failure returns plain HTTP 400 JSON (stream never opens). A model call that makes no progress for `CLARITY_MODEL_INACTIVITY_MS` is aborted by the inactivity watchdog and surfaces as `run.error { code: 'INTERNAL' }` with a stall hint (decision 15).
- **Cancellation** is client-initiated: `AbortController.abort()` tears down the fetch; the route's `request.signal` abort listener and the `ReadableStream.cancel()` callback both fire one server-side controller, which stops in-flight fetches (via `AbortSignal.any` with the deadline signal) and model calls (via the AI SDK `abortSignal` option) — no orphaned token spend. No wire event is attempted (undeliverable by definition — pairing on abort is a client-side responsibility, per guarantee 3): the client reducer transitions to `cancelled` and marks in-flight steps cancelled the moment it aborts, keeping everything already rendered. If the stream closes without a terminal event and the user did *not* abort, the reducer dispatches a local `transport_error` — the UI can never hang in `running`.

### Sibling routes

- **`POST /api/draft`** — same SSE envelope, three types: `draft.started {}`, `draft.delta { text: string }`, `draft.completed { note: DraftNote }` (or `run.error`). Request: `{ profile, hooks, contact? }`.
- **`POST /api/contact`** — plain JSON (no long-running steps to visualize): request `{ profile: ListingProfile, coverage: { tiers: { tier, status, sources: SourceRef[] }[] } }` → `200 { candidates: ContactCandidate[], sourcesTried: { id: string, status: 'found' | 'none' | 'skipped', skip?: FetchSkip }[] }`; errors as `{ code, message }` with 4xx/5xx. The route re-reads needed pages through the cache-backed PageFetcher (a small 3-fetch contact budget) rather than accepting page text from the client; the `listing:pasted` ref is never fetched — listing-derived candidates use `profile.rawText`.
- **`GET /api/health`** — `200 { provider: { id: 'openai' | 'anthropic' | 'ollama' | 'unconfigured', model?: string, reachable?: boolean } }`; for Ollama it pings the **configured `OLLAMA_BASE_URL`** (default `http://localhost:11434`), read from the same composition root (`src/server/deps.ts`) that `createModelProvider` reads, with a 2s timeout.

---

## 4. Domain design

### Layering (enforced, not hoped)

`src/domain/**` imports only from `src/shared/schema`, `src/domain`, and provider *interface* files (which are type-only). An ESLint `no-restricted-imports` rule forbids `next`, `ai`, `jsdom`, `cockatiel`, `cheerio`, `bottleneck`, `node:fs` in the domain layer. `src/server/deps.ts` is the single composition root (the one place env is read — provider selection, `OLLAMA_BASE_URL`, budgets, watchdog interval); route handlers import only deps + domain + schema and are thin adapters.

### Pipeline orchestration — `AnalysisPipeline.ts`

```ts
async function runAnalysis(
  input: AnalyzeInput,
  deps: PipelineDeps,          // { model: ModelProvider; fetcher: PageFetcher; clock: Clock; budgetConfig }
  emit: (event: PipelineEvent) => void,   // sink; SSE adapter lives OUTSIDE the domain
  signals: { cancel: AbortSignal }        // user cancellation; deadline signal is created internally
): Promise<void>
```

An emit-callback design (not an async generator) because Stage 2's parallel fetches must surface events as they happen — a pull-based generator cannot yield from concurrent tasks. The `sse.ts` adapter stamps `seq`, encodes frames, and runs the heartbeat timer.

Control flow: create `RunBudget` → `run.started` → **Stage 1** (fatal on failure) → `extraction.completed` → **Stage 2** (never fatal) → `enrichment.completed` → **Stage 3** (sections, then hooks) → `run.completed`. `signals.cancel.aborted` is checked at every stage boundary and between sections; on user abort, the function returns silently — the sink is dead, so no pairing frames are emitted (the client reducer handles step closure locally, per §3 guarantee 3). On a thrown `PipelineError` (a live stream), outstanding steps ARE paired with `cancelled` skips before `run.error`. Stage 4 and the draft are deliberately NOT in this pipeline (separate opt-in routes per spec §3/§6).

**Stage 1 — `ListingExtractor`.** Text input goes straight to `model.extract`; the pipeline records the submission time and constructs `pastedListingRef(submittedAt)` as the run's Tier-0 source (decision 33). URL input: one budgeted `fetcher.fetchClean` — a skip here IS fatal (`INPUT_INVALID`, message steering to the paste-text path). Extraction prompt forbids inventing fields (missing optionals stay absent). `domainDeriver` post-processes `domain`: a job-board host (greenhouse.io, lever.co, ashbyhq.com, myworkdayjobs.com, … — literal denylist) is never the company domain; fall back to the `applicationContact` email domain, then the model's extraction from the text, else undefined.

**Stage 2 — `CompanyEnricher`.** Tier 0 = the listing itself, recorded `found` at zero cost: for URL input its source is the real fetched `SourceRef`; for text input its source is the canonical `pastedListingRef` (`listing:pasted`). Tier 1 = `candidateUrls(domain)`: `https://{domain}`, `/about`, `/careers`, `/jobs`, `/product` (≤ 5, one host — the per-host limiter serializes them, bounded by the tier pre-check). Tier 2/3 = `linkDiscovery` over fetched Tier-1 pages: same-org GitHub links, blog/engineering/changelog links, news/press links found in real anchors; fallback slug-guesses (`github.com/{domain-sans-tld}`, `blog.{domain}`) are used only if discovery found nothing and count as `found` only when the fetched page's title/text loosely matches the company name. Per tier: pre-check `budget.remainingMs() > MIN_USEFUL_MS (1500)` or mark all remaining tiers `skipped_budget` and emit `budget.exhausted` once; then `tryAcquire` per candidate BEFORE dispatch (a parallel burst can never overshoot `maxFetches`), dispatch acquired candidates via `Promise.allSettled`, emit `step.started`/`step.finished` per source. Per-source cleaned text is capped (~6k chars) and stored server-side in `EnrichmentResult.extracted` (for text input, Tier 0's extracted text is `profile.rawText`); the wire gets SourceRefs only. Tier status: `found` if ≥1 CleanPage, `skipped_budget` if every candidate was budget-skipped, else `not_found`.

**Stage 3 — `BriefingSynthesizer` + `HookSynthesizer`.** Fixed section plan (`what-they-do`, `product-area`, `stack`, `team-signals`, `seniority-fit`, `recent-launches`). For each section, `confidenceRules` deterministically selects relevant sources from coverage and computes confidence: `none` → the section is emitted instantly with canned "Not found in available sources." and NO model call; `low` → only listing-text support, and the section's `sources` cite the listing ref (the real fetched SourceRef for URL input, `pastedListingRef` for text input — never empty); `high` → company-page/blog support. Sourced sections stream serially via `model.streamSynthesis`, each prompt containing only that section's own source excerpts, framed as untrusted quoted material. Then a `step.started("Finding outreach hooks…")` covers `HookSynthesizer`: one `extract()` producing ≤ 3 hooks over numbered source excerpts; post-parse, every cited URL is validated against the set of actually-fetched SourceRefs **plus the run's Tier-0 listing ref** (so listing-grounded hooks on the paste path survive with `listing:pasted` citations), and offending hooks are dropped (the drop is visible as `step.finished { status:'ok' }` with the surviving count in the label, or a `detail` note). Zero hooks is legal. **Synthesis is never killed by the wall-clock deadline** (documented spec deviation, decision 15); it is governed by the user cancel signal **plus the per-call inactivity watchdog**: every `extract` and `streamSynthesis` call is wrapped by `inactivityWatchdog.ts`, which aborts the call if no delta/completion progress arrives for `CLARITY_MODEL_INACTIVITY_MS` (default 300 000 ms) and surfaces `run.error { code: 'INTERNAL' }` with a stall hint — a hung provider stream (or stuck Stage-1 extract) is bounded even if the user walks away.

**Stage 4 — `ContactSurfacer`** (via `/api/contact`): runs the configured `ContactSource[]` (v1: exactly `PublicSourceContactSurfacer`), concatenates, sorts `verified > public > guess`, dedupes, caps at 5, strips phone-shaped strings. Candidates: (1) `profile.applicationContact` → `{ channel:'listing', confidence:'public' }`, whose mandatory `source` is the listing's SourceRef — the real fetched ref for URL input, `pastedListingRef` for pasted text; (2) small `extract()` over the (cache-re-read) careers page for named recruiters → `{ channel:'careers', confidence:'public' }`; (3) `githubSignal` for engineering roles — org page fetched through the same robots-aware PageFetcher (no API token, no 60/hr limit), org-page-only scope (no commit-email harvesting, §7), counted only on a loose company-name match → `{ channel:'github', confidence:'public' }`; (4) `emailPattern` — only when a real name AND domain exist, always `confidence:'guess'`, never SMTP-probed; (5) a `{ channel:'linkedin', confidence:'guess' }` "right channel" candidate per named person, whose `source` is the SourceRef of the page where the name was found (satisfying §5's mandatory `source`; `pastedListingRef` when the name came from pasted text), with the people-search URL in `value`. Nothing is ever persisted.

**`NoteDrafter`** (via `/api/draft`): streams the note body via `streamSynthesis` from user-visible hooks (+ optional selected contact), then a final `extract()`-free assembly validates `groundedHooks ⊆` the supplied hook texts before `draft.completed`. The same inactivity watchdog bounds the draft stream.

### Run budget mechanics — `RunBudget.ts`

`createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, clock)` (env-overridable, clamped server-side: ≤ 20 / ≤ 120_000):

```ts
interface RunBudget {
  tryAcquire(label: string): BudgetToken | null;  // null => budget_exhausted skip recorded, NO network dispatched
  remainingMs(): number;
  fetchesUsed(): number;
  deadlineSignal: AbortSignal;                    // armed by the route adapter; domain stays timer-free in tests
}
interface BudgetToken { timeoutMs: number /* min(10_000, remainingMs()) */; signal: AbortSignal }
```

Rules: one acquisition per `fetchClean` dispatch, counted at acquisition, never refunded (a timed-out fetch consumed real wall-clock; refunds would let one slow host starve the ceiling); robots.txt lookups are amortized inside the unit (fetched once per origin per process); cache hits bypass acquisition entirely (what makes re-runs near-free). The wall clock is enforced three ways: (a) `tryAcquire` returns null past deadline; (b) per-fetch cockatiel timeout is clamped to remaining time; (c) `deadlineSignal` aborts in-flight fetches at the deadline. Fetch calls receive `AbortSignal.any([cancel, deadlineSignal])`; model calls receive `AbortSignal.any([cancel, watchdogSignal])` — the deadline never touches them (decision 15). `Clock` injection lets `RunBudget.test.ts` jump a fake clock — tests run in milliseconds.

### Provider interfaces (exact spec signatures)

- **`ModelProvider`** (§4.1 verbatim): `{ id; extract<T>(input, schema: ZodSchema<T>, opts?): Promise<T>; streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string> }`. `createModelProvider` reads `MODEL_PROVIDER=openai|anthropic|ollama` (auto-detect from present keys if unset): `openai(modelId)` / `anthropic(modelId)` / `ollama(modelId)` from `ai-sdk-ollama` (base URL from `OLLAMA_BASE_URL` via the composition root). `extract` = `generateText({ output: Output.object({ schema }), temperature: 0, abortSignal })` in `extractWithRepair.ts`, catching `NoObjectGeneratedError` for exactly one repair re-prompt (raw `err.text` + zod issues appended) before throwing `EXTRACTION_FAILED`. `streamSynthesis` = `streamText({ ..., abortSignal }).textStream`. Both are wrapped by `inactivityWatchdog.ts` (progress-reset abort timer, decision 15). Unconfigured → `MODEL_UNCONFIGURED` naming the exact env vars.
- **`PageFetcher`** (§4.2): `fetchClean(url, token) → CleanPage | FetchSkip`, never throws into the pipeline. Gate order: (0) page cache, (1) robots gate, (2) per-host limiter (inside the policy execute), (3) cockatiel `wrap(perOriginBreaker, retry(handleAll, { maxAttempts: 2, ExponentialBackoff }), timeout(token.timeoutMs, Aggressive))`, (4) content-type/size guards (`not_html`, `too_large` > 2MB), (5) `readabilityClean` with `isProbablyReaderable` routing to `cheerioStrip`, soft-404 heuristic (min cleaned length; title not matching /404|not found/i → else `empty_content` skip). UA: `ClarityBot/0.1 (+https://github.com/<user>/clarity; local job-research tool)`.
- **`ContactSource`** (§4.3 verbatim): `{ id; find(profile, coverage): Promise<ContactCandidate[]> }`.
- **`SearchProvider`**: `{ id; search(query, budget): Promise<SourceRef[]> }` — interface only, referenced nowhere in v1.
- **`PageCache`**: `{ get(url): Promise<CleanPage | null>; set(page): Promise<void> }`, 24h TTL via `fetchedAt`, corrupt file = miss.

### Skip/error taxonomy

Two disjoint families, enforced by types:
- **`FetchSkip`** (returned, never thrown): reasons `robots_disallowed | timeout | http_status | not_html | network | too_large | empty_content | circuit_open | budget_exhausted | cancelled`. `budget_exhausted` and `cancelled` are produced by the enricher/pipeline (no dispatch; `url` set when a candidate URL exists, omitted on non-fetch steps like a cancelled hooks step); the rest by the fetcher, always with `url`. Coverage mapping: `budget_exhausted` → `skipped_budget`; all others → `not_found` (spec defines only three tier statuses; per-step reasons remain fully visible in the timeline). The 10-reason taxonomy is one shared `FetchSkipReasonSchema` used by both fetcher-produced and pipeline-produced skips.
- **`PipelineError`** (thrown, caught once at the pipeline's outer try/catch): `INPUT_INVALID | MODEL_UNCONFIGURED | EXTRACTION_FAILED | INTERNAL`. Only Stage 1, model configuration, and the inactivity watchdog can raise one; Stages 2–3 are otherwise structurally incapable of killing a run.

---

## 5. Core schemas (zod v4, written out)

All in `src/shared/schema/`; TS types via `z.infer`. Model-facing extraction calls pass `providerOptions: { openai: { strictJsonSchema: false } }` so `.optional()` fields survive OpenAI strict mode.

```ts
// sourceRef.ts
export const PASTED_LISTING_URL = 'listing:pasted' as const;
export const SourceRefSchema = z.object({
  // Either a real fetched URL or the canonical synthetic id for pasted listing text
  // (decision 33) — the only non-URL value that may ever appear here.
  url: z.union([z.url(), z.literal(PASTED_LISTING_URL)]),
  label: z.string().min(1),
  fetchedAt: z.iso.datetime(),   // for pasted text: the submission timestamp
});
export type SourceRef = z.infer<typeof SourceRefSchema>;
export const pastedListingRef = (submittedAt: string): SourceRef => ({
  url: PASTED_LISTING_URL,
  label: 'Pasted listing text',
  fetchedAt: submittedAt,
});

// listingProfile.ts
export const ListingProfileSchema = z.object({
  company: z.string().min(1),
  domain: z.string().optional(),
  role: z.string().min(1),
  seniority: z.string().optional(),
  namedTechnologies: z.array(z.string()).default([]),
  productArea: z.string().optional(),
  teamSignals: z.string().optional(),
  applicationContact: z.string().optional(),
  listingUrl: z.url().optional(),
  rawText: z.string().max(20_000),
});

// fetch.ts
export const FetchSkipReasonSchema = z.enum([
  'robots_disallowed', 'timeout', 'http_status', 'not_html', 'network',
  'too_large', 'empty_content', 'circuit_open', 'budget_exhausted', 'cancelled',
]);
export const FetchSkipSchema = z.object({
  kind: z.literal('skip'),
  // Always set by the fetcher; optional because pipeline-produced skips on
  // non-fetch steps (cancelled hooks/synthesis steps) have no URL to cite.
  url: z.url().optional(),
  reason: FetchSkipReasonSchema,
  detail: z.string().optional(),
  httpStatus: z.number().int().optional(),
});
export const CleanPageSchema = z.object({
  kind: z.literal('page'),
  url: z.url(),
  finalUrl: z.url(),
  title: z.string(),
  text: z.string(),
  fetchedAt: z.iso.datetime(),
});

// enrichment.ts
export const TierStatusSchema = z.enum(['found', 'not_found', 'skipped_budget']);
export const TierCoverageSchema = z.object({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  status: TierStatusSchema,
  sources: z.array(SourceRefSchema),
  extracted: z.record(z.string(), z.unknown()),   // per-source capped text; SERVER-SIDE ONLY, never on the wire
});
export const EnrichmentResultSchema = z.object({
  tiers: z.array(TierCoverageSchema),
  fetchesUsed: z.number().int().nonnegative(),
});
// What enrichment.completed carries: counts only. Per-tier SourceRef[] already
// arrived on the wire via enrichment.tier.completed, so neither `sources` nor
// `extracted` appears here — this matches the §3 event table exactly.
export const EnrichmentWireSummarySchema = z.object({
  tiers: z.array(z.object({
    tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    status: TierStatusSchema,
    sourceCount: z.number().int().nonnegative(),
  })),
  fetchesUsed: z.number().int().nonnegative(),
});

// briefing.ts
export const ConfidenceSchema = z.enum(['high', 'low', 'none']);
export const SECTION_PLAN = [
  'what-they-do', 'product-area', 'stack', 'team-signals', 'seniority-fit', 'recent-launches',
] as const;
export const BriefingSectionSchema = z.object({
  id: z.enum(SECTION_PLAN),
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: ConfidenceSchema,
  sources: z.array(SourceRefSchema),   // empty iff confidence === 'none'; 'low' cites the listing ref (real or pasted)
});
export const BriefingSchema = z.object({ sections: z.array(BriefingSectionSchema) });

// hook.ts
export const HookSchema = z.object({
  text: z.string().min(1),
  basis: z.string().min(1),
  confidence: ConfidenceSchema.exclude(['none']),
  sources: z.array(SourceRefSchema).min(1),   // an uncited hook cannot exist; listing-grounded hooks cite the
                                              // listing ref (listing:pasted on the paste path)
});

// contact.ts
export const ContactChannelSchema = z.enum(['listing', 'careers', 'github', 'linkedin', 'inferred-email']);
export const ContactConfidenceSchema = z.enum(['verified', 'public', 'guess']);
export const ContactCandidateSchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  channel: ContactChannelSchema,
  value: z.string().optional(),
  confidence: ContactConfidenceSchema,
  source: SourceRefSchema,             // mandatory: even linkedin candidates cite the page the name came from;
                                       // channel:'listing' candidates from pasted text cite pastedListingRef
});

// draftNote.ts
export const DraftNoteSchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1),
  groundedHooks: z.array(z.string()),  // validated subset of displayed hook texts
});

// analyzeInput.ts
export const AnalyzeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.url() }),
  z.object({ kind: z.literal('text'), text: z.string().min(40).max(50_000) }),
]);

// events.ts — the wire protocol (discriminated on `type`; every payload from §3 above)
export const PipelineEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string(), provider: z.object({ id: z.string() }),
             budget: z.object({ maxFetches: z.number().int(), deadlineMs: z.number().int() }),
             input: z.object({ kind: z.enum(['url', 'text']) }) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('stage.started'), stage: z.enum(['extraction', 'enrichment', 'synthesis']) }),
  z.object({ type: z.literal('step.started'), stepId: z.string(), stage: z.enum(['extraction', 'enrichment', 'synthesis']),
             label: z.string(), url: z.url().optional(), tier: z.number().int().min(0).max(3).optional() }),
  z.object({ type: z.literal('step.finished'), stepId: z.string(), status: z.enum(['ok', 'skipped']),
             skip: FetchSkipSchema.optional(), source: SourceRefSchema.optional(), cached: z.boolean().optional() }),
  z.object({ type: z.literal('extraction.completed'), profile: ListingProfileSchema }),
  z.object({ type: z.literal('enrichment.tier.completed'), tier: z.number().int().min(0).max(3),
             status: TierStatusSchema, sources: z.array(SourceRefSchema) }),
  z.object({ type: z.literal('budget.exhausted'), kind: z.enum(['fetches', 'wall_clock']),
             fetchesUsed: z.number().int(), elapsedMs: z.number().int(), skippedTiers: z.array(z.number().int()) }),
  z.object({ type: z.literal('enrichment.completed'), summary: EnrichmentWireSummarySchema }),
  z.object({ type: z.literal('synthesis.section.started'), sectionId: z.enum(SECTION_PLAN), title: z.string(),
             confidence: ConfidenceSchema, sources: z.array(SourceRefSchema) }),
  z.object({ type: z.literal('synthesis.delta'), sectionId: z.enum(SECTION_PLAN), text: z.string() }),
  z.object({ type: z.literal('synthesis.section.completed'), section: BriefingSectionSchema }),
  z.object({ type: z.literal('synthesis.hooks.completed'), hooks: z.array(HookSchema).max(3) }),
  z.object({ type: z.literal('run.completed'), runId: z.string(), elapsedMs: z.number().int(), fetchCount: z.number().int() }),
  z.object({ type: z.literal('run.error'), code: z.enum(['INPUT_INVALID', 'MODEL_UNCONFIGURED', 'EXTRACTION_FAILED', 'INTERNAL']),
             message: z.string(), hint: z.string().optional(), stage: z.string().optional() }),
  // draft stream reuses the envelope:
  z.object({ type: z.literal('draft.started') }),
  z.object({ type: z.literal('draft.delta'), text: z.string() }),
  z.object({ type: z.literal('draft.completed'), note: DraftNoteSchema }),
]);
```

---

## 6. UI design

### Component tree

```
app/page.tsx (server)
└── AnalyzeView (client)
    ├── ListingInputForm            — URL | paste-text toggle; provider chip ("Claude · your key" / "Ollama · local"
    │                                 from GET /api/health); submit; disabled while running
    ├── CancelButton                — visible only while phase === 'running'
    ├── AgentStepTimeline           — one StepRow per step.started, grouped under stage headers
    │   └── StepRow                 — pulsing dot → check / muted skip; label; source link; skip reason; "cached" tag
    ├── ProfileCard                 — company/role/seniority/tech chips at extraction.completed
    ├── CoverageSummary             — Tier 0–3 chips (found solid / not_found hollow / skipped_budget dashed)
    │                                 + "7/12 fetches, 3 sources found"; budget.exhausted note
    ├── BriefingSectionCard[]       — one per synthesis.section.started, in arrival order
    │   ├── ConfidenceBadge         — rendered BEFORE any tokens (confidence is in section.started)
    │   ├── SourceCitations         — SourceRef chips; external links w/ fetchedAt tooltip; pasted-listing chip is non-link
    │   └── StreamingText           — memoized per-section delta append with caret
    ├── HookCard[]                  — at synthesis.hooks.completed: text, basis, badge, citations, copy
    ├── ContactPanel                — "Find a contact for this role" button, mounts ONLY after run.completed
    │   └── ContactCandidateCard[]  — channel icon, name/role, value, badge; sourcesTried shown when empty
    └── DraftNotePanel              — streamed via /api/draft; [Open in mail (mailto:)] [Copy]; app never sends
```

### Client state machine

One `useReducer` in `useAnalysisRun.ts`. Reducer input is literally `PipelineEvent | LocalAction` (`LocalAction = { type: 'submit' | 'aborted' | 'reset' | 'transport_error' }`). No state library.

```ts
interface RunState {
  phase: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  runId?: string;
  provider?: { id: string };
  lastSeq: number;                                   // duplicate/ordering guard
  steps: StepView[];                                 // ordered, keyed by stepId
  profile?: ListingProfile;
  tiers: Partial<Record<0 | 1 | 2 | 3, { status: TierStatus; sources: SourceRef[] }>>;
  budgetNotice?: { kind: 'fetches' | 'wall_clock'; skippedTiers: number[] };
  sections: Record<SectionId, { title: string; confidence: Confidence; sources: SourceRef[]; text: string; done: boolean }>;
  sectionOrder: SectionId[];
  hooks: Hook[];
  fatal?: { code: string; message: string; hint?: string };
}
```

`runReducer` switches exhaustively on `event.type` with a `satisfies never` default — a new event type is a compile error. The local `aborted` action is the authoritative close-out for client-initiated cancellation: it sets phase `cancelled` AND marks every open step cancelled (the server sends no pairing frames on a dead connection — §3 guarantee 3). It is a pure function tested by replaying recorded `.jsonl` fixtures from `fixtures/event-streams/` — full UI-contract coverage with zero DOM and zero network — including an abort-mid-enrichment fixture asserting the `aborted` action closes all open steps.

### Transport

`useAnalysisRun.start(input)`: create `AbortController` → `fetch POST` → `response.body.getReader()` → `parseSse.ts` (incremental buffer split on `\n\n`, `TextDecoder` with `{ stream: true }`, partial frames buffered across chunks — torture-tested) → `JSON.parse` + `PipelineEventSchema.parse` (the client validates the wire too) → drop `seq <= lastSeq` → dispatch. Reader completes without a terminal event and without user abort → `transport_error` (phase `error`, partials kept). Contact and draft use the same `parseSse` helper (draft) or plain JSON (contact).

### How each §8 showpiece is achieved

- **Live agent-step visualization** — every `step.started` appends a running StepRow ("Reading careers page…"); `step.finished` flips it to a check (+ source link + "cached" tag) or a muted skip row with the exhaustive human label per reason ("blocked by robots.txt", "timed out", "skipped — run budget spent", "cancelled"). Skips are first-class honest outcomes — the degrades-honestly non-negotiable made visible.
- **Progressive card rendering** — nothing waits for `run.completed`: ProfileCard at `extraction.completed` (~seconds in), tier chips per `enrichment.tier.completed`, each briefing card mounts at `section.started`, hooks land after their visible step. A 40s run reads as continuous progress; `heartbeat` keeps liveness during long model calls.
- **Streaming synthesis** — `StreamingText` appends `synthesis.delta.text`; sections stream serially so exactly one caret is live; per-section memoization keeps token-cadence re-renders cheap; `section.completed` swaps in canonical content.
- **Source citations** — `SourceCitations` chips render from `section.started` *before* tokens arrive; hooks and contacts compose the same primitive; the canonical `listing:pasted` ref renders as a non-link "Pasted listing text" chip (same visual grammar, no href), so the sparse paste path is cited, not citation-free; there is no render path for a section/hook/candidate that omits its citations — the only citation-free renders are explicit absence states ("not found", "skipped").
- **Cancellation** — CancelButton → `abort()` → reducer `aborted` → phase `cancelled`, active steps marked cancelled locally, all rendered partials kept ("Run cancelled — showing what was found."); server-side, the composed signal kills fetches and model streams.
- **Coverage/confidence indicators** — `ConfidenceBadge` renders both scales: `high` solid "grounded", `low` amber "listing-only", `none` gray "not found"; contact `guess` gets an unmistakable dashed-border treatment with "guessed pattern — unverified", and DraftNotePanel refuses to auto-insert a `guess` email into the mailto target without an explicit "use this guess" click.

---

## 7. Build sequence (spec §9, each increment verified before the next)

**1 — Skeleton + schemas.**
Steps: `npx create-next-app@latest apps/web` (TS, App Router, no Tailwind); add our `src/` layout + tsconfig paths; write ALL §5 schemas including `events.ts` and the canonical pasted-listing source (`PASTED_LISTING_URL` + `pastedListingRef` in `sourceRef.ts`) (types/zod only, no logic); ESLint layering rule; root `.gitignore` (incl. `apps/web/data/`); vitest config; placeholder `page.tsx`; `engines: { node: ">=22" }`.
Files: everything under `src/shared/schema/`, `app/layout.tsx`, `app/page.tsx`, configs.
Verify: `npm run build` passes; `npx vitest run` passes schema round-trip tests (parse a hand-written ListingProfile fixture and one of each event type; reject `confidence: 'medium'` and an unknown skip reason; parse a `pastedListingRef` inside a Hook and a ContactCandidate; parse a `step.finished { status:'skipped', skip:{ kind:'skip', reason:'cancelled' } }` frame with no `url`).

**2 — ModelProvider.**
Steps: `ModelProvider.ts` interface per §4.1; `extractWithRepair.ts` (`generateText` + `Output.object`, one repair re-prompt on `NoObjectGeneratedError`); `inactivityWatchdog.ts` (progress-reset abort timer around extract/stream calls, `CLARITY_MODEL_INACTIVITY_MS` default 300 000 — decision 15); `createModelProvider.ts` env switch (`openai(…)`/`anthropic(…)`/`ollama(…)` from `ai-sdk-ollama`, `OLLAMA_BASE_URL` honored), `MODEL_UNCONFIGURED` with env-var hint, `<think>`-tag stripping for qwen3; `FakeModelProvider.ts`; `.env.example`; `scripts/try-model.ts`. Deps: `ai@^7.0.14`, `@ai-sdk/openai@^4.0.7`, `@ai-sdk/anthropic@^4.0.7`, `ai-sdk-ollama@^4.0.0`, `zod@^4`.
Verify: `npx tsx scripts/try-model.ts` with (a) a cloud key and (b) `MODEL_PROVIDER=ollama` + `qwen3:4b`: prints a zod-validated `{ name, city }` extracted from a sentence, then streams a two-sentence completion chunk-by-chunk; unconfigured run exits with the `MODEL_UNCONFIGURED` message naming the env vars; unit test proves the repair-retry path with a fake that fails validation once; unit test proves the watchdog aborts a fake stream that stalls (fake timers) and does NOT abort a slow-but-progressing stream.

**3 — PageFetcher + RunBudget.** *(RunBudget moved here — the fetcher consumes BudgetTokens, fixing the winner's sequencing bug.)*
Steps: `PageFetcher.ts` interface; `clock.ts`; `RunBudget.ts` (+ tests, fake clock); `resilience.ts` (cockatiel wrap(breaker, retry, timeout), skip mapping incl. `circuit_open`); `robotsGate.ts` (globalThis cache, 404 ⇒ allow, 5xx ⇒ skip, cross-origin `undefined` handled, crawl-delay); `hostRateLimiter.ts` (Bottleneck.Group on globalThis); `readabilityClean.ts` + `cheerioStrip.ts` (isProbablyReaderable routing, soft-404/empty-content heuristic, `window.close()` in finally); `RobotsAwarePageFetcher.ts` composing the gates; descriptive UA; `next.config.ts` externals. Deps: `cockatiel@4.0.0`, `robots-parser@3.0.1`, `@mozilla/readability@0.6.0` (exact), `jsdom@^29.1.1`, `cheerio@^1.2.0`, `bottleneck@2.19.5`.
Verify: `npx tsx scripts/try-fetch.ts <real listing url>` prints title + first 500 chars; a robots-disallowed path prints `{kind:'skip', reason:'robots_disallowed'}`; a dead domain prints `network` after visible backoff; a 1-fetch budget makes the second call return `budget_exhausted` with zero network; unit tests map every failure mode to a typed skip (injected fetch stubs: 404, hang, disallow, thin page, aborted signal), no throws; `RunBudget.test.ts` passes on a fake clock.

**4 — Stage 1 extraction end-to-end.**
Steps: `ListingExtractor.ts` (text path constructing `pastedListingRef(submittedAt)` as the run's Tier-0 source; URL path with fatal `INPUT_INVALID` on skip, message steering to paste); extraction prompt in `prompts.ts` forbidding invented fields; `domainDeriver.ts` + denylist tests; save 3 listing fixtures.
Verify: `npx tsx scripts/try-extract.ts fixtures/listings/sparse-startup.txt` and `--url <live greenhouse listing>` both print zod-valid ListingProfiles; the text-path result carries the `listing:pasted` Tier-0 ref; the greenhouse run does NOT set `domain` to greenhouse.io; run once with `MODEL_PROVIDER=ollama` (qwen3:4b) to prove keyless extraction.

**5 — /api/analyze streaming route + UI shell (Stage 1 only).**
Steps: `AnalysisPipeline.ts` (run.started → extraction → run.completed/run.error, cancel checkpoints, outstanding-step pairing on server-side terminals per §3 guarantee 3); `sse.ts` (frame encoder, seq stamping, heartbeat timer, close-on-abort); `deps.ts` (single env read point incl. `OLLAMA_BASE_URL`); `analyze/route.ts` (`runtime='nodejs'`, `dynamic='force-dynamic'`, prompt Response return, `request.signal` + `cancel()` → one AbortController); `health/route.ts` (pings the configured `OLLAMA_BASE_URL` from `deps.ts`, not a hardcoded host); client: `parseSse.ts` (+torture tests), `runReducer.ts` (+fixture tests, incl. `aborted` closing open steps), `useAnalysisRun.ts`, `AnalyzeView`, `ListingInputForm` (provider chip), `AgentStepTimeline`, `StepRow`, `ProfileCard`, `CancelButton`; real `page.tsx`.
Verify: `curl -N -X POST localhost:3000/api/analyze -d '{"kind":"text","text":"..."}'` shows ordered SSE frames ending in one terminal event — **against both `next dev` and `next build && next start`** (dev buffering differs; `compress: false` if dev batches); browser run shows live steps then ProfileCard; garbage URL → `run.error` banner with the paste-steering hint; Cancel mid-extraction → UI `cancelled` with the open step closed by the local `aborted` action, server debug log shows the abort checkpoint fired and the model call stopped; SSE-adapter test asserts outstanding steps are paired before `run.error` on a thrown `PipelineError`; `/api/health` with `OLLAMA_BASE_URL` pointed at a non-default port reports `reachable` correctly.

**6 — Stage 2 tiered enrichment.**
Steps: `candidateUrls.ts` (+tests); `linkDiscovery.ts` (+tests, incl. name loose-match fallback rule); `coverage.ts` (incl. wire-summary fold to `{ tier, status, sourceCount }`); `CompanyEnricher.ts` (tier loop, Tier-0 source = fetched ref or `pastedListingRef`, MIN_USEFUL_MS pre-check, tryAcquire-before-dispatch, allSettled, per-source step events, server-side text cap, `budget.exhausted` emission); extend pipeline; `CoverageSummary.tsx`; env knobs.
Verify: run against a company with a real website → parallel Tier-1 rows interleave, tier chips land progressively, dead candidates show as honest skips; a paste-text run shows Tier 0 `found` citing "Pasted listing text"; `CLARITY_MAX_FETCHES=2` → later tiers read `skipped_budget`, `budget.exhausted` note renders, server log shows no extra network; enricher unit tests with FakePageFetcher prove exact budget scenarios (2 acquired, 4 budget-skipped) and that one dead page never sinks a tier with live siblings; round-trip test proves `enrichment.completed` parses with counts only (no `sources`/`extracted` on the wire).

**7 — Stage 3 synthesis with progressive cards.**
Steps: `confidenceRules.ts` (+tests, incl. `low` sections always citing the listing ref — real or pasted); `BriefingSynthesizer.ts` (fixed plan, instant no-model-call `none` sections, serial per-section streams with per-section source excerpts, untrusted-source framing); `HookSynthesizer.ts` (extract ≤3 hooks, citation validation against fetched refs + the Tier-0 listing ref, covering step events); prompts; extend pipeline; UI: `BriefingSectionCard`, `StreamingText`, `ConfidenceBadge`, `SourceCitations` (non-link pasted-listing chip), `HookCard`; reducer handling.
Verify: rich-company run → cards mount one at a time, badges + citation chips visible before tokens, text streams, hooks arrive under a visible "Finding outreach hooks…" step with working source links; sparse paste-text run → complete briefing with `none` sections reading "Not found in available sources.", `low` sections and listing-grounded hooks citing the non-link "Pasted listing text" chip, zero fabricated hooks (0 is legal); unit test proves a fixture hook citing an unfetched URL is dropped while one citing `listing:pasted` on the paste path survives; Cancel mid-synthesis keeps completed sections; a long Ollama synthesis is NOT killed by the wall clock (deadline bounds fetching only — assert in a unit test with a fake clock past deadline during Stage 3) but a stalled stream IS killed by the inactivity watchdog with `run.error INTERNAL` + hint (fake-timer unit test).

**8 — Stage 4 contact surfacing + streamed draft note.**
Steps: `ContactSource.ts`; `PublicSourceContactSurfacer.ts` + `githubSignal.ts` (org-page-only, name loose-match) + `emailPattern.ts` (+tests); `ContactSurfacer.ts` (rank/dedupe/cap/strip-phones); `contact/route.ts` (SourceRef-only request, cache-backed re-reads — never attempting to fetch `listing:pasted`, listing-derived candidates use `profile.rawText`; `sourcesTried` in response, no persistence); `NoteDrafter.ts` + streamed `draft/route.ts`; UI: `ContactPanel` (post-run only), `ContactCandidateCard` (guess treatment), `DraftNotePanel` (streamed body, mailto: + copy, guess click-through).
Verify: no contact network fires before the click (network tab + server log); a fixture with `recruiting@acme.dev` renders a `public`/`listing` candidate — on the paste path its `source` is the pasted-listing ref and the card's citation chip is the non-link variant; a fixture without contacts renders inferred-email + LinkedIn candidates with dashed "guess — unverified" styling and `sourcesTried` "checked listing, careers page, GitHub — none found"; draft streams token-by-token; "Open in mail" launches the client prefilled; a `guess` email enters the mailto only after the explicit click; `groundedHooks` verbatim-subset check unit-tested; grep confirms no SMTP/nodemailer dependency; `dir apps\web\data` confirms no contact data on disk.

**9 — Local page cache (flat JSON).**
Steps: `PageCache.ts`; `JsonFilePageCache.ts` (sha256(url) keys, CleanPage payload, 24h TTL, corrupt ⇒ miss); wire as gate 0 in the fetcher (hits bypass budget + limiter); `cached: true` on `step.finished` → "cached" tag; confirm gitignore.
Verify: same listing twice → second run's enrichment completes in ~1–2s, steps tagged "cached", `run.completed.fetchCount` near 0; `git status` clean under `data/`; deleting one cache file mid-run refetches gracefully; unit test proves hits bypass `tryAcquire`.

**10 — README pass.**
Steps: write `README.md` from the spec: what it is; quickstart (clone → `cd apps/web` → `npm i` → copy `.env.example` → `npm run dev`); three provider setups with the honest Ollama tradeoff paragraph naming known-good models (`qwen3:4b` default, `llama3.2:3b`, `phi4-mini:3.8b`); privacy section ("your job-search activity never leaves your machine" — stated as a feature per §1.2); good-citizen section (robots.txt, rate limiting, descriptive UA, no mail sending, no SMTP probing, no phone numbers); a note that the user is the data controller of their own outreach; coverage-honesty explanation; §2 architecture sketch; **a "design notes / spec deviations" subsection recording decision 15** (the wall-clock ceiling bounds fetching only; synthesis is bounded by user cancel + a per-stream inactivity watchdog instead, so slow local models never self-cancel).
Verify: the §10 definition-of-done walkthrough performed literally from the README on a machine with NO API key: Ollama per README → paste a listing → live streamed pipeline → honest cited briefing (with "Pasted listing text" citations where the listing is the only source) → opt-in contact → draft note copied into a mail client. That walkthrough succeeding IS v1 done.

---

## 8. Risks and mitigations

1. **Small local models fail structured extraction more often than cloud models.** Mitigated by: `ai-sdk-ollama`'s native schema-constrained decoding (not the /v1 shim), temperature 0, the one repair re-prompt, optional fields in `ListingProfile`, and increment-2 smoke tests against a real local model; README names known-good tags. Worst case the run fails honestly with `EXTRACTION_FAILED`.
2. **JS-rendered listing pages (Ashby/Workday) yield thin Readability output.** The paste-text path is the guaranteed fallback (spec makes it first-class); the `INPUT_INVALID`/`empty_content` copy actively steers users to paste. No headless browser in v1; a JSON-LD `JobPosting` fallback in `readabilityClean` is a cheap v1.1.
3. **ATS hosts' robots.txt may disallow generic bots.** Being a good citizen means visibly skipping and steering to paste; verify real Greenhouse/Lever robots policies during increment 3, not at the end.
4. **Soft-404s pollute coverage as false `found`.** Cheap heuristic in `readabilityClean` (min cleaned length, 404-ish title ⇒ `empty_content`); name loose-match on slug-guessed URLs; accept residual imperfection — honest `not_found` beats cleverness.
5. **Qwen3 `<think>` blocks leak into extraction/synthesis.** Provider impl disables thinking where supported and strips `<think>…</think>` from any raw text; covered by the increment-2 smoke test.
6. **OpenAI strict-mode rejects `.optional()` schemas.** `providerOptions.openai.strictJsonSchema: false` on extraction calls; if a schema still misbehaves, switch that extraction variant to `.nullable()` + a null→undefined normalizer.
7. **SSE buffering (dev server, proxies, antivirus).** `X-Accel-Buffering: no`, `no-transform`, `compress: false` in dev, heartbeats for intermediaries, and the increment-5 `curl -N` gate against BOTH dev and production builds before any UI work.
8. **AbortSignal plumbing is fiddly (deadline-mid-retry, cancel-mid-fetch, orphaned model streams, watchdog-vs-cancel races).** One composed signal per concern (`AbortSignal.any([cancel, deadline])` for fetches; `AbortSignal.any([cancel, watchdog])` for model calls), always the cockatiel `execute({ signal })`, explicit unit tests for deadline-fires-mid-retry, user-cancels-mid-fetch, and watchdog-fires-mid-stream, and increment 5/7 verifies server-side abort logs. The watchdog also means a hung provider stream is bounded even with nobody watching (decision 15).
9. **Per-host rate limiting × parallel Tier-1 fetches can eat the wall clock** (5 same-host URLs serialize behind 1s spacing). Clamped per-fetch timeouts + the MIN_USEFUL_MS tier pre-check bound it; cap same-host candidates at ~5 and tune in increment 6.
10. **jsdom is heavy (memory + event-loop blocking on big pages).** Confined to the server via `serverExternalPackages`, `window.close()` in finally, 2MB body cap, parallelism capped at ~4 per tier, cheerio fallback for non-article pages; cheerio is the sanctioned swap if profiling shows pressure.
11. **Next dev HMR resets module state (robots cache, limiters, breakers).** All held on `globalThis` singletons.
12. **Prompt injection via fetched pages.** All fetched text is framed as untrusted quoted source material; hooks are citation-validated so fabrications are at least traceable; contact extraction runs over the same framed text.
13. **Email-pattern inference + a real name is personal-data processing (GDPR/CAN-SPAM).** No persistence, no SMTP probing, explicit unverified labeling, user-initiated only, phone stripping, org-page-only GitHub scope; README states the user is the data controller of their own outreach.
14. **Context-window overflow on 8k-window local models.** Per-source 6k cap + per-section source selection; caps are named constants in one place, lowered if increment-7 Ollama testing demands.
15. **Token-cadence re-renders jank with multiple live cards.** Sections stream serially (one caret) and `StreamingText` is memoized per section; if profiling still shows jank, batch deltas behind a 16ms rAF buffer in `useAnalysisRun`.
16. **Community Ollama provider churn.** `ai-sdk-ollama@^4` explicitly peer-depends on `ai@^7`; pinned in package.json; the ModelProvider seam means a provider swap touches one file.
17. **A too-tight inactivity window could kill legitimate slow CPU-Ollama generations.** The watchdog resets on every delta (progress-based, not total-duration), defaults to a generous 5 minutes, and is env-tunable (`CLARITY_MODEL_INACTIVITY_MS`); increment-7 verification includes a real slow local-model synthesis passing untouched.