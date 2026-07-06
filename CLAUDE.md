# Clarity — working notes

Local-first, free job-listing research tool. The Next.js app lives in `apps/web/`.

## Source-of-truth documents (read before coding)

- `clarity-v1-spec.md` — the product spec.
- `docs/PLAN.md` — the authoritative implementation plan: 33 keyed decisions, complete
  file tree, the full SSE event protocol, zod schemas, per-increment build + verify
  steps, risks. **Where PLAN.md is more specific than the spec, PLAN.md governs.**
- `docs/ARCHITECTURE.md` — the same architecture as Mermaid diagrams (layers, pipeline,
  wire protocol, schema map, fetcher gate chain, client state machine, roadmap).

## Build protocol

Build strictly in PLAN.md §7 increment order. For increment N: read its steps and its
verification list, build only that increment (no scaffolding ahead), run the full gate
(`npm run test`, `npm run lint`, `npm run build` in `apps/web/`, plus the increment's
specific verification actions), then update **Current state** below. Do not re-litigate
the decisions in PLAN.md §1 — they were researched and adversarially judged.

## Current state (update at the end of every increment)

- [x] 1 — Skeleton + schemas (done 2026-07-03: 41/41 tests, lint clean, build passes,
      layering rule proven with an import probe)
- [x] 2 — ModelProvider (done 2026-07-04: 89/89 tests, lint clean, build passes;
      unconfigured `try-model.ts` run prints MODEL_UNCONFIGURED naming the env vars and
      exits 1; adversarial review's 3 confirmed coverage gaps closed with wiring tests.
      **Deferred verification:** (b) CLEARED 2026-07-04 — Ollama 0.31.1 installed via
      winget, `qwen3:4b` pulled, live smoke passes: zod-valid extract + clean
      two-sentence stream (after the think-split fix below). (a) the cloud-key smoke
      remains deferred until a key exists in `.env.local`.)
- [x] 3 — PageFetcher + RunBudget (done 2026-07-04: 157/157 tests, lint clean, build
      passes; live `try-fetch.ts` verified all four §7 scenarios — Stripe jobs page
      cleaned, google `/search` → `robots_disallowed`, dead domain → `network` after
      visible retry backoff, 1-fetch budget → `budget_exhausted` with zero network —
      plus a real Greenhouse board through its cross-host redirect. Risk-3 check:
      Greenhouse & Ashby robots allow listing paths for `*`; Lever allows `*` with
      `Crawl-delay: 1` (honored). Adversarial review confirmed 3 findings (non-http
      scheme bypass, crawl-delay/timeout starvation, schema-invalid skip `url`) — all
      fixed with regression tests; see the fetcher-internals deviation bullet below.)
- [x] 4 — Stage 1 extraction end-to-end (done 2026-07-05: 204/204 tests, lint clean,
      build passes; live keyless (Ollama qwen3:4b) §7 proofs all green — sparse +
      greenhouse-style + lever-style fixtures each print zod-valid profiles with the
      `listing:pasted` Tier-0 ref and zero fetches; live Greenhouse URL run
      (job-boards.greenhouse.io, 17k chars cleaned) spends exactly one budgeted fetch,
      cites the fetched page, and leaves `domain` absent rather than greenhouse.io.
      Adversarial review: 1 finding mutation-confirmed 3/3 (URL-path rawText cap was
      unpinned) plus self-adjudicated fixes — enterprise-ATS + freemail denylist
      entries, all-emails scan, fence-token neutralization, title-label clip,
      blank-optional normalization, required-field trim with ZodError→EXTRACTION_FAILED
      mapping, BudgetToken identity pin — all regression-tested; see the Stage-1
      deviation bullet below.)
- [x] 5 — /api/analyze SSE route + UI shell (done 2026-07-05: 263/263 tests, lint clean,
      build passes; live §7 proofs all green — `curl -N` text run against BOTH `next dev`
      AND `next build && next start` streams ordered frames (run.started at seq 0,
      heartbeats every 10s during the ~30s keyless qwen3:4b extract, exactly one
      terminal event); dead-domain URL → honest `network` skip row paired BEFORE
      `run.error INPUT_INVALID` with the paste-steering hint; client abort
      mid-extraction → zero terminal frames attempted, server log shows the abort
      checkpoint firing and the run settling; `/api/health` with `OLLAMA_BASE_URL` on a
      non-default port reports reachable honestly both ways (false against the empty
      port, true through a TCP proxy on it); the real parseSse+runReducer driven over
      the live prod wire finish `phase: done` with the profile rendered (timestamped
      frames prove no buffering); headless-browser screenshot confirms the shell.
      Adversarial review (6 finder dimensions, 3-lens refutation): 4 confirmed findings
      (all UI) + 1 split-vote finding self-adjudicated, all fixed with regression
      tests; see the increment-5 deviation bullets below.)
- [x] 6 — Stage 2 tiered enrichment (done 2026-07-05: 319/319 tests, lint clean, build
      passes; layering probe re-proven (FakePageFetcher import from a non-test domain
      file still fails lint). Live §7 proofs all green on keyless qwen3:4b — Vercel
      paste: domain extracted from the text, 5 parallel Tier-1 rows dispatched in one
      tick and finishing interleaved ~1s apart behind the host limiter, tier-2
      candidates mined from REAL homepage anchors (github.com/vercel, /blog,
      /changelog — decision 20 live), chips progressive, counts-only summary,
      fetchCount 9; `CLARITY_MAX_FETCHES=2`: exactly 2 acquired, 7 budget-skipped
      steps started+finished the same instant (zero network), tiers 2–3
      skipped_budget, ONE `budget.exhausted {kind:fetches, skippedTiers:[2,3]}`, run
      still completed; sparse Driftlock paste: Tier 0 found citing "Pasted listing
      text", tiers 1–3 honest not_found (zero-candidate rule), zero fetches; Oxide
      run: /jobs + /product 404s render as honest http_status skips beside live
      siblings, /about's redirect cited under its final URL, discovery found
      github.com/oxidecomputer where the slug guess would have wrongly tried
      github.com/oxide; the real parseSse+runReducer driven over the live wire
      finished phase done, progressive chips, zero open steps; the MAX_FETCHES=2
      stream is recorded as `fixtures/event-streams/text-run-budget.jsonl` and
      replayed in reducer tests. Adversarial review: the 6-finder/3-lens workflow was
      cut short by a session usage limit (only the security finder + one verify lens
      completed); its 5 candidate findings were self-adjudicated in the main loop —
      all 5 real in mechanism, all 5 fixed with regression tests (see the increment-6
      hardening bullet below) — and the five unfinished dimensions got a focused
      main-loop self-review instead.)
- [ ] 7 — Stage 3 streamed synthesis ← **NEXT**
- [ ] 8 — Stage 4 contact surfacing + streamed draft
- [ ] 9 — Flat-JSON page cache
- [ ] 10 — README pass (the §10 keyless walkthrough IS the definition of done)

## Deviations from PLAN.md already in the code

- Every fetchable-URL field uses `HttpUrlSchema = z.url({ protocol: /^https?$/ })`
  (`src/shared/schema/sourceRef.ts`) — bare `z.url()` follows WHATWG parsing and admits
  any scheme, including `javascript:`. `listing:pasted` stays the only non-web-URL
  SourceRef value. Scheme-rejection tests pin this; don't revert to bare `z.url()`.
- The ESLint layering rule (`apps/web/eslint.config.mjs`) uses gitignore-style
  `patterns`, not `paths`: deep subpaths (`cheerio/slim`), `@/`-aliased and relative
  escapes are all covered, and only the five provider interface files are importable
  from `src/domain/**`. Negations need parent-dir re-inclusion — a `!file` pattern is
  dead if its parent directory stays excluded.
- Pulled forward, content-correct, to be claimed by their increments: `.env.example`
  (claimed by increment 2; the file is read-protected by permission settings, so it is
  verified by this record) and `serverExternalPackages: ['jsdom']` in `next.config.ts`
  (increment 3 verifies it once jsdom is installed).
- `src/domain/pipeline/errors.ts` was claimed by increment 2 (the PLAN.md tree assigns
  it no increment; the model layer needs typed MODEL_UNCONFIGURED/EXTRACTION_FAILED).
  `thinkStrip.ts` is a pre-split helper not in the PLAN.md tree (200-line ceiling).
- **ai-sdk-ollama's chat path ignores `abortSignal` entirely** (verified in its dist —
  only embed/rerank/image thread it). The inactivity watchdog therefore races every
  await against its own signal so the RUN terminates even when the provider ignores the
  abort (decision 15's guarantee); the stall error travels as the abort reason, and a
  non-cooperating request may leak server-side. Increments 5/7 must not assume that
  aborting the signal actually kills an Ollama generation.
- Fetcher internals hardened beyond the plan text (increment 3, review-driven), all in
  `src/providers/fetch/`: robots.txt lookups run through the same per-origin
  breaker+retry policy as pages (dead host ⇒ honest `network` skip; 5xx/timeout ⇒
  conservative `robots_disallowed`; the whole 4xx class ⇒ allow per RFC 9309, not just
  404; bodies truncated at 512 KiB per RFC 9309 §2.4). The per-attempt timeout starts
  INSIDE the host-limiter queue slot (`runFetchAttempts` in `resilience.ts`) so
  politeness waits — including honored 10s crawl delays — can never fabricate `timeout`
  skips. Outer-signal cancellations are excluded from breaker/retry accounting
  (unfiltered cockatiel counts aborts as failures and opens the circuit — verified
  empirically); cockatiel's `maxAttempts: 2` means 2 RETRIES ⇒ 3 attempts per fetch.
  Non-http(s) URLs (mailto:, javascript: — increment-6 link discovery will feed these)
  are rejected pre-dispatch with url-less schema-valid skips; cross-origin redirect
  targets get a post-hoc robots check before their content is used.
- `createRunBudget` extends the §4 shape two ways: optional `cancel?: AbortSignal` in
  the config (the ONE place `AbortSignal.any([cancel, deadline])` is composed into
  tokens) and `fireDeadline()` on the created budget for the route adapter's real
  timer — the domain itself stays timer-free (decision 22). `FakePageFetcher` is
  deferred to increment 6, its first consumer (no scaffolding ahead).
- `reliableObjectGeneration: false` is set on the Ollama model: that package's default
  reliability layer re-prompts up to 3× and fabricates fallback values, conflicting
  with the single-repair rule (decision 6) and never-fabricates (decision 16). Cloud
  model ids are constants in `createModelProvider.ts` (gpt-5-mini / claude-sonnet-5),
  not env knobs — the plan's `.env.example` var list governs.
- **Ollama qwen3 `think` handling is split by call type** (live-verified 2026-07-04 on
  Ollama 0.31.1): decision 30's "disable thinking" holds for EXTRACTION only
  (`think: false` + schema-constrained decoding — grammar keeps residual reasoning out
  of the JSON). For SYNTHESIS, `think: false` now backfires on 2026 qwen3 builds — the
  model reasons INLINE in `message.content` (sometimes with a stray `</think>`), where
  no tag-stripper can catch it. The synthesis model instance therefore sets no `think`
  at all: Ollama's default separates reasoning into `message.thinking`, which
  ai-sdk-ollama keeps out of `textStream`. `thinkStrip.ts` remains as belt-and-braces
  for models emitting literal tags. Don't "simplify" the two instances back into one.

- Stage 1 hardened beyond the plan text (increment 4, live-smoke- and review-driven),
  in `src/domain/listing/`: `extractionNormalize.ts` and `extractorTestKit.ts` are
  pre-split helpers not in the PLAN.md tree (200-line ceiling; the extractor tests are
  split into `.text.test.ts`/`.url.test.ts` for the same reason). qwen3:4b fills
  optional fields with `""` under schema-constrained decoding (live-verified), so blank
  optionals are structurally normalized to ABSENT — absence must mean "not stated";
  required fields are trimmed, and a composed profile failing the final schema parse
  maps ZodError → `EXTRACTION_FAILED`, so no raw ZodError escapes the 4-code taxonomy.
  `RAW_TEXT_MAX` is exported from `listingProfile.ts` and single-sources the 20k cap;
  the model extracts from EXACTLY `profile.rawText` (the cap also strips a
  slice-severed surrogate), so pasted text beyond 20k (input allows 50k) is
  deliberately not analyzed — documented deviation. The domain denylist covers
  enterprise ATS hosts (taleo, successfactors, brassring, oraclecloud, …) AND freemail
  providers (hiring@gmail.com must not make gmail.com the enrichable "company
  domain"); every email in the contact text competes, not just the first. The
  extraction prompt's `<<<LISTING` fences are neutralized inside embedded listing
  text, and fetched page titles are clipped to 200 chars at SourceRef construction.
  **Increment-5 note:** a user-cancel mid-listing-fetch surfaces as a `cancelled` skip
  → `INPUT_INVALID` throw; the pipeline must check `signals.cancel.aborted` before
  mapping a caught PipelineError to `run.error` (PLAN.md's silent-return-on-abort).
  (Implemented and pinned by AnalysisPipeline tests in increment 5.)

- Increment-5 pre-splits, not in the PLAN.md tree (200-line ceiling):
  `src/domain/pipeline/steps.ts` (step-event constructors + `StepEmit`),
  `src/domain/listing/listingFetchError.ts` (listing-fetch skip → INPUT_INVALID copy),
  `src/providers/model/modelSelection.ts` (pure selection half of the env switch —
  `describeModelSelection`; `createModelProvider` re-exports it so run.started's
  provider id, the health chip, and the constructed provider can never disagree), and
  `src/components/runState.ts` (RunState/StepView/actions; `runReducer.ts` keeps only
  transitions). `ListingExtractor` gained an optional `onStep` emitter — stage modules
  emit their own step pairs (the pattern increment 6's enricher will reuse):
  skip-terminated steps are finished BEFORE the throw; a step left open by a thrown
  error is deliberately left for the pipeline's terminal pairing (§3 guarantee 3).
- `PipelineDeps` deviates from the PLAN.md §4 sketch two ways: `getModel()` is LAZY
  (an unconfigured provider becomes `run.error MODEL_UNCONFIGURED` ON the stream,
  after a `run.started` whose provider id comes from `describeModelSelection` — the
  route can never crash pre-frame), and `scheduleDeadline` is an injected timer seam
  (deps.ts arms the real `setTimeout`; the domain still owns no timers, decision 22).
  The client reducer drops ALL wire frames whenever `phase !== 'running'` — that
  single guard is what makes a stale pump harmless across cancel→resubmit.
  `/api/health` reports selected-but-keyless cloud providers as `unconfigured` (chip
  honesty) and pings `GET {OLLAMA_BASE_URL}/api/version` with a 2s timeout.
- Increment-5 adversarial review (6 finder dimensions; per-finding 3-lens refutation):
  4 confirmed findings, all UI — an over-50k paste got "paste at least 40 characters"
  copy (fixed via the exported pure `validateListingInput`, which names the 50k cap);
  duplicate `namedTechnologies` made duplicate React keys (fixed at the source:
  `normalizeExtraction` now dedups after trim); the mode toggle claimed tablist/tab
  ARIA without the keyboard contract (now honest `aria-pressed` buttons); a
  mode-specific validation error survived mode switches (cleared on switch). One
  1-refuter/1-confirmer split was self-adjudicated and fixed: a deadline-fired listing
  fetch read as bare "the run was cancelled" — `cancelled` skips now surface their
  `detail` ("Run deadline reached after N ms.") in the INPUT_INVALID message. All but
  the mode-switch fix carry regression tests (that one is setState wiring with no DOM
  test rig in this increment).

- **`CleanPage` gained an optional `links` field** (increment 6, deviation from the
  §5 schema): the cleaners drop hrefs, so decision 20's "candidates discovered from
  links found in real anchors" is impossible without capture.
  `src/providers/fetch/extractLinks.ts` captures ≤ 300 absolute http(s) anchors
  (`{url, text}`, text ≤ 120 chars, url ≤ 2 048 chars — over-long URLs are DROPPED,
  they'd reach the wire as `step.started.url`) from the raw HTML before cleaning.
  Capture is best-effort (a crash there never skips a cleaned page); `links` never
  rides the wire.
- The ESLint layering rule gained a **test-only carve-out** (increment 6):
  `src/domain/**/*.test.ts` may additionally import
  `providers/fetch/FakePageFetcher` — the fake is vendor-free and typed against the
  interface seams, and PLAN.md §7 explicitly pairs it with the enricher unit tests.
  Production domain files keep the strict five-interface list (probe re-proven).
- Enricher implementation notes (increment 6): `enricherTestKit.ts` and the
  `CompanyEnricher.{budget,discovery}.test.ts` splits are pre-splits under the
  200-line ceiling. Tier-2/3 discovered-candidate caps are `TIER2_MAX = 3` /
  `TIER3_MAX = 2` (plan doesn't pin them; risk-9 tuning), with at most one GitHub
  org candidate. A slug-guess failing the loose name match surfaces as an
  `empty_content` skip whose detail says the page "never mentions" the company (the
  10-reason taxonomy has no closer fit). Zero-candidate tiers are `not_found`,
  never `skipped_budget` — a skip chip must not claim the budget stopped work that
  never existed. `budget.exhausted` notices are bucketed per kind and flushed at
  every exit, so both kinds can appear (each at most once, §3) and a wall-clock
  stop cannot swallow a pending fetches notice. `RunState.fetchesUsed` extends the
  §6 sketch (the "7/12 fetches" tally needs it; set by `enrichment.completed`,
  re-set by `run.completed`).
- **Increment-6 review-driven hardening** (5 findings, all fixed with regression
  tests): (1) `looseNameMatch` strips full URLs and hostname-shaped tokens from the
  haystack before matching — a parked "blog.acme.dev is for sale" page no longer
  passes on its hostname echo. **Known accepted residual (risk 4):** github
  org/user pages title-echo their slug ("{slug} · GitHub"), so a single-token
  company name equal to its domain label still passes on a stranger's org; the
  discovered-link path (preferred over guessing) is unaffected. (2) Link discovery
  refuses private/intranet hosts (IP literals, localhost, single-label names,
  `.local`/`.corp`/`.internal`/… TLDs, `.home.arpa`) — fetched pages are
  attacker-influenced and must not steer the server-side fetcher inward. (3)
  `RobotsAwarePageFetcher` skips (`empty_content`) any fetch whose redirect
  INTRODUCES a sign-in path (`/login`, `/signin`, `/signup`, `/auth`) —
  live-observed: vercel.com/product → `/login?next=…` had counted as a found
  source; fetching a login URL directly is still honored. (4) captured link URLs
  are length-capped (see the links bullet). (5) the fetches/wall_clock notice
  bucketing above.

## Commands

All in `apps/web/`: `npm run test` (vitest), `npm run lint`, `npm run build`,
`npm run dev`.
