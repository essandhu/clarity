# Clarity — working notes

Local-first, free job-listing research tool. The Next.js app lives in `apps/web/`.

## Source-of-truth documents (read before coding)

- `clarity-v1-spec.md` — the product spec.
- `docs/PLAN.md` — the authoritative implementation plan: 33 keyed decisions, complete
  file tree, the full SSE event protocol, zod schemas, per-increment build + verify
  steps, risks. **Where PLAN.md is more specific than the spec, PLAN.md governs.**
- `docs/ARCHITECTURE.md` — the same architecture as Mermaid diagrams (layers, pipeline,
  wire protocol, schema map, fetcher gate chain, client state machine, roadmap).
- `docs/PLAN-RESUME.md` — the authoritative v1.1 plan (tailored-resume feature,
  approved 2026-07-12): decisions 34–60, increments 11–16, risks 18–31. **It governs
  increments 11–16 the way PLAN.md governs 1–10; PLAN.md's 33 decisions still govern
  the existing system unchanged.**

## Build protocol

Build strictly in PLAN.md §7 / PLAN-RESUME.md §7 increment order. For increment N: read
its steps and its verification list, build only that increment (no scaffolding ahead),
run the full gate (`npm run test`, `npm run lint`, `npm run build` in `apps/web/`, plus
the increment's specific verification actions), then update **Current state** below. Do
not re-litigate the decisions in PLAN.md §1 or PLAN-RESUME.md §1 — they were researched
and adversarially judged.

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
      replayed in reducer tests. Adversarial review ran in TWO passes (both cut short
      by session usage limits, so findings were self-adjudicated in the main loop):
      pass 1 (only the security finder + one verify lens completed) yielded 5 findings,
      pass 2 (5 of 6 finders + partial verify, at commit 6da77a1) yielded 13 across
      correctness/protocol/security/plan/ui. Deduped, that is 10 distinct findings: 8
      fixed with regression tests, 2 accepted with rationale. Final gate 326/326 tests,
      lint clean, build passes; post-fix live Oxide re-run byte-identical to pre-refactor
      (4 tiers found, fetchCount 9). See the two increment-6 hardening bullets below.)
- [x] 7 — Stage 3 streamed synthesis (done 2026-07-06: 372/372 tests, lint clean, build
      passes; live §7 proofs on keyless qwen3:4b — sparse Driftlock paste: complete
      briefing with 4 `low` sections citing the non-link "Pasted listing text" ref,
      stack/recent-launches emitted instantly as `none` with canned copy and ZERO model
      calls, one listing-grounded hook citing `listing:pasted`, zero fetches, phase
      `done` via the real parseSse+runReducer over the live wire; recorded as
      `fixtures/event-streams/text-run-synthesis.jsonl` and replayed in reducer tests
      (full replay + abort-mid-synthesis prefix + run.error/transport_error variants);
      rich Oxide URL run (oxide.computer/careers): high sections cite the fetched pages
      with badge+citation frames arriving BEFORE the first delta, sections strictly
      serial, hooks under a visible "Finding outreach hooks…" step; wall-clock unit
      test proves a deadline firing mid-synthesis never kills the streams (and the
      Oxide run proves it live — its deadline fired during tier 1), and the fake-timer
      pipelineStall test proves a stalled stream dies as run.error INTERNAL with the
      stall hint. **The live runs caught a real decision-15 violation**: with `think`
      unset, ai-sdk-ollama DROPS qwen3's separated thinking before it becomes stream
      parts, so a >300s think phase (observed twice, 300s+ on one section) read as a
      watchdog stall and killed healthy runs — fixed by consuming `fullStream`
      (reasoning deltas are watchdog progress) + `think: true` on the synthesis
      instance + pinning `num_ctx` (see the increment-7 deviation bullets).
      Adversarial review (workflow: 6 finder dimensions, cross-finder dedupe, 3
      refutation lenses per finding, 42 agents): 12 confirmed findings deduping to 6
      roots, ALL fixed with regression tests — (1) terminal states never closed open
      SECTIONS (caret blinked forever on cancelled/errored runs; the reducer now
      closes them in the aborted/transport_error/run.error arms), (2) an all-dropped
      hooks batch read as a clean check (now an honest `empty_content` skip naming
      the drop, per §4 drop-visibility), (3) attacker-controlled page TITLES escaped
      the SOURCE fence (labels+urls now neutralized too), (4) neutralizeFences wasn't
      a fixed point ("SOURCE>>>>" regenerated a live token; now regex-collapses whole
      bracket runs), (5) HookCard copy threw on non-secure-context clipboard, (6)
      rankByUrl scored the registrable domain (productboard.com ranked 'product'
      everywhere; now subdomains+path only).)
- [x] 8 — Stage 4 contact surfacing + streamed draft (done 2026-07-06: 476/476 tests,
      lint clean, build passes; live §7 proofs on keyless qwen3:4b against the PROD
      build, driven by the real parseSse + runReducer/draftReducer over the live wire —
      contact-bearing Driftlock paste: full run to phase `done`, THEN the opt-in
      POST /api/contact (the route's log line is the §7 user-initiation anchor; zero
      contact activity before it) returned the `recruiting@driftlock.io` listing
      candidate as `public` citing the NON-LINK pasted ref, sourcesTried
      listing found / careers none / github none; /api/draft streamed `draft.started`
      at seq 0 → 72 deltas (timestamped spread proves no buffering) → `draft.completed`
      with a mechanical subject and groundedHooks 3/3 verbatim-⊆ — including a ~28-min
      qwen3 think phase that rode heartbeats + reasoning-progress without tripping the
      watchdog. No-contact Driftlock paste (a named Head of Engineering, no
      email): the sole-rawText-URL domain fallback set driftlock.io, tier 1
      dispatched 5 candidates in one tick that all skipped as honest instant
      `network` rows (dead domain) and the tier-2 slug guesses likewise; the
      contact search returned ONLY guesses — Maya Chen as a LinkedIn
      right-channel candidate plus the maya.chen@driftlock.io first.last
      inferred pattern, "nothing presented as fact" asserted over the whole
      response — with sourcesTried listing/careers/github all `none`; the
      zero-hooks draft path streamed 19 deltas to a completed note with
      groundedHooks `[]`. grep: no SMTP/nodemailer dependency; no data/
      directory exists (nothing persisted). The first live run
      caught a real §7 failure — qwen3:4b garbled the listing email into
      "recruiting@dr:driftlock.io" during Stage-1 extraction, so the listing candidate
      surfaced valueless — fixed with the `soleEmail` rawText fallback (see bullets)
      and re-proven live. Adversarial review (workflow: 6 finder dimensions,
      cross-finder dedupe, 3 refutation lenses per finding, 52 agents): 19 raw → 15
      distinct → 12 CONFIRMED findings, ALL fixed — 2 high (model-reported person
      emails wore a `public` badge with no grounding against the source text,
      bypassing decision 28's accept-click into mailto; contact re-fetches guarded the
      dialed host but not the redirect's FINAL host — SSRF via 30x), 6 medium
      (draft stream leaked on unmount; draftNotePrompt embedded company/role
      unfenced; no length caps on client-supplied prompt fields; github scope was
      host-only so a repo/commit path widened org-page-only; a note drafted for
      contact A survived a switch to contact B's mailto; a third divergent
      CleanPage→SourceRef builder), 4 low (unanchored careers-path regex matched
      /blog/steve-jobs-tribute; isEngineeringRole admitted "Data Entry Clerk" via bare
      \bdata\b + the namedTechnologies catch-all; mailto recipient '@' was
      percent-encoded, invalid per RFC 6068; contactExcerpt re-implemented
      capExcerpt) — each with a regression test except the two React-wiring fixes
      (unmount abort, remount keys), which have no DOM rig (increment-5 precedent).
      3 findings were refuted by the lenses (route-glue duplication and
      EmailGuess.pattern are plan-pinned; phone-strip-on-label is unreachable).)
- [x] 9 — Flat-JSON page cache (done 2026-07-06: 525/525 tests, lint clean, build
      passes; layering probe re-proven — the PageCache INTERFACE imports clean from
      domain, the JsonFilePageCache IMPLEMENTATION is lint-rejected. Live §7 proofs
      on keyless qwen3:4b against the PROD build, driven by the real
      parseSse + runReducer over the live wire (`scripts/try-cache.ts`, a new smoke
      script — see the deviation bullets). COLD run (oxide.computer/careers,
      CLARITY_DEADLINE_MS=120000 so tiers 2–3 fit behind the ~15s CPU extraction):
      7 pages fetched and cached (8 files — exactly one redirect wrote its finalUrl
      alias), tiers 0–3 all found, the /jobs + /product 404s honest skips and NOT
      cached, zero cached tags, fetchesUsed 9. WARM re-run: `listing-fetch ok
      CACHED` at 0.1s with no acquisition, every previously-found page CACHED with
      zero wall-clock (tiers 2–3 completed in the same tick), the run's ONLY
      network the two honestly-refetched 404 candidates — enrichment window 5.5s,
      of which the cached portion is ~0s; two briefing sections then completed
      citing the cached sources before the multi-hour CPU synthesis was
      deliberately stopped (it exercises nothing cache-related; full synthesis
      completion was proven live in increments 7–8). DELETION run: one cache file
      (the listing's) deleted between runs → that URL alone refetched gracefully
      (ok, unCACHED, one acquisition) beside 6 CACHED siblings, tiers all found,
      `enrichment.completed fetchesUsed=3` on the wire vs 9 cold (§7's "near 0"),
      and the write-through restored the deleted file; the --enrich-only client
      abort tore down with zero open steps. `git check-ignore` pins
      apps/web/data/, and git status shows zero data/ entries with a populated
      cache on disk. Adversarial review (workflow: 6 finder dimensions,
      cross-finder dedupe, 3 refutation lenses per finding, 34 agents): 12 raw → 9
      distinct → 5 CONFIRMED findings, ALL fixed with regression tests — (1) the
      deps.ts cache wiring was unpinned (the repro lens mutation-tested it live:
      reverting to a cacheless fetcher kept all 513 then-tests green; now a
      composition-root test seeds a sentinel through the REAL PAGE_CACHE_DIR), (2)
      the §7 "cached" tag had zero client coverage (reducer propagation now
      pinned), (3) budget.exhausted could mislabel wall_clock as fetches when
      remainingMs() expired during the new async peek yield (kind now consults
      remainingMs too), (4) PAGE_CACHE_DIR's cwd anchoring could drop snapshots
      outside the gitignore (root-anchored /data/ safety net added), (5) cache fs
      I/O was unbounded (settleByAbort races peeks/gate-0/write-through against
      deadline/token signals). 4 findings refuted 2/3 — warm-run robots staleness
      and cwd anchoring recorded as accepted residuals in the deviation bullets.)
- [x] 10 — README pass (done 2026-07-06: 525/525 tests, lint clean, build passes.
      `README.md` written at the repo root with every §7-increment-10 pinned
      section — what it is, quickstart, three provider setups + the honest Ollama
      tradeoff naming qwen3:4b/llama3.2:3b/phi4-mini:3.8b, privacy-as-feature,
      good-citizen, data-controller note, coverage honesty, architecture sketch,
      and a design-notes subsection recording decision 15 plus the 20k rawText
      cap. **The spec-§10 definition-of-done walkthrough was performed literally
      from the README on this keyless machine**: no `.env.local` existed, so it
      was created per README step 2 (`cp .env.example .env.local` +
      `MODEL_PROVIDER=ollama`; dotenv last-assignment-wins makes the append
      authoritative), `/api/health` then resolved ollama/qwen3:4b/reachable (the
      "Ollama · local" chip state); `scripts/try-walkthrough.ts` drove the live
      `npm run dev` wire through the REAL parseSse + runReducer +
      buildContactRequest + draftReducer + mailtoEmail/mailtoHref:
      sparse-startup paste → extraction 28.4s → tiers 0 found / 1–3 not_found
      with 0 fetches → briefing with 4 low sections each citing the non-link
      listing:pasted ref + 2 none sections completing instantly → 3
      listing-grounded hooks → run.completed phase done, zero open steps → POST
      /api/contact ONLY after done (1 linkedin right-channel `guess` citing the
      pasted ref, sourcesTried listing/careers/github all none, nothing claims
      `verified`) → draft.started at seq 0 → 69 deltas riding a ~15-min qwen3
      think phase → draft.completed with groundedHooks verbatim-⊆ and the
      mechanical subject → recipient-less mailto: href (the sole candidate has
      no email; decision 28 honored). Briefing+hooks ≈ 4.5 min, draft ≈ 15 min
      on CPU; all 13 driver assertions passed, exit 0 — **v1 is done per spec
      §10**. Adversarial review (workflow: 8 finder dimensions, cross-finder
      dedupe, 3 refutation lenses per finding, 57 agents): 25 raw → 16 distinct
      → 13 CONFIRMED (2 high), ALL fixed — 12 README corrections (the
      SSRF-guarantee sentence rescoped to request-time filtering, UI labels made
      byte-exact — "Copy note"/"Open in mail"/"guessed — unverified"/"blocked by
      robots.txt", timing restated against recorded evidence, cache speedup
      scoped to the fetch phase, watchdog described as covering extract() too,
      layering claim itemized, analyze route = stages 1–3, sparse-fixture
      walkthrough step qualified, "fully local" scoped to model traffic, public
      badge wording) plus one code fix (`SearchProvider.ts`, bullet below); 3
      refuted (2/3+ lenses).)
- [x] 11 — Master profile: schema, store, editor, pasted-resume import (done
      2026-07-12: 599/599 tests, lint clean, build passes; layering probe
      re-proven — a domain file importing `JsonFileProfileStore` fails lint.
      **Decision-58 live go/no-go: GO** — Ollama 0.31.1 + qwen3:4b streams
      deltas under `format`-constrained decoding (16 deltas / 3.1s spread on
      the probe), so the stream-backed extract's watchdog feed works with no
      fallback constant needed. Live §7.11 proofs on keyless qwen3:4b against
      the PROD build via `scripts/try-import.ts` (real parseSse +
      importReducer): 77s/104s/82s imports, `profile.import.started` at seq 0,
      7–10 heartbeats riding each extract, 8 entries with ZERO dropped strings,
      the driver re-running the verbatim gate client-side over EVERY string
      (dates incl.) + provenance + zod-valid merge + PUT→GET byte-equal, exit
      0; ZERO Ollama context-shift lines (fixture prompt 632 tokens; n_ctx_slot
      8192 confirmed in the server log) — RESUME_IMPORT_MAX stays 12k; abort
      proof: mid-extract client abort ⇒ zero further frames, reducer idle,
      server abort checkpoint logged; recovery proof: hand-corrupt →
      GET `unreadable` naming the `.bak`, PUT sans overwrite → 409, browser
      start-fresh with explicit overwrite → `.bak` BYTE-INTACT (sha256) and
      corrupt bytes aside as `master.json.corrupt-<ts>`; browser proof: all 7
      §6 editor-contract items ticked against the running app via headless
      system Edge (playwright-core in the scratchpad, zero repo deps);
      `data/profile/` populated on disk with zero `data/` entries in git
      status. Adversarial review (workflow: 6 finder dimensions, cross-finder
      dedupe, 3 refutation lenses per finding, 58 agents): 18 raw → 17
      distinct → 13 CONFIRMED, ALL fixed with regression tests — (F1) the
      streamed extract's system/abortSignal/providerOptions threading was
      unpinned (deleting any kept 589 tests green; the exact increment-9
      unpinned-wiring class — now pinned on both the unit and the
      openai-wiring surface), (F2) the date gate matched fragments ('dec' ⊆
      'decreased', '2002' ⊆ '20024') and passed vacuously on non-ASCII-digit
      dates — now whole-token membership with cross-form month matching
      (Jan ⇄ January) and a substring fallback for symbols-only dates, (F3)
      a fatal-key early return skipped gating/reporting the entry's remaining
      strings — the walk now completes and names EVERY failure, (F4)
      profileMerge aliased an appended skills group and mutated the caller's
      ImportedEntries (StrictMode double-invoke skew), (F5) save() clobbered
      edits/merges landed while the PUT was in flight (now a functional
      update folding in only the timestamp), (F6) this record, (F8) over-cap
      report paths used post-grounding indices while not-verbatim used
      original ones — keptIndices now give the whole report ONE index base,
      (F9) the drop header accused the verbatim gate of over-cap drops (report
      now partitioned by reason), (F12) a zero-add merge bumped updatedAt and
      lied "Unsaved changes" (now returns the profile unchanged + honest
      "added nothing new" copy), (F14) validation copy painted untouched
      fields (now blur-gated per §6; the Save-row line stays always-on),
      (F15) CSV inputs silently destroyed items past the cap (now uncapped —
      the zod max fires with named copy), (F16) projects had no url editor
      field, (F17) bullet textareas/link inputs had no accessible names. 4
      refuted 1/3 (fence-neutralization haystack mismatch — unreachable in
      resume text; tmp-name concurrency — single-user local posture per plan;
      DNS-rebinding on the GET — out of increment scope per standing v1
      posture; unreadable mid-session dead-end — the documented restore path
      covers it). Post-fix live re-run green (82s, exit 0). See the
      increment-11 deviation bullets below.)
- [ ] 12 — GitHub + LinkedIn importers
- [ ] 13 — Tailoring pipeline + /api/tailor + handoff + coverage/diff/toggles
- [ ] 14 — LaTeX generation (.tex deliverable)
- [ ] 15 — Tectonic compile + PDF preview + health chip
- [ ] 16 — README + v1.1 walkthrough pass

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
- **Ollama qwen3 `think` handling is split by call type** (live-verified 2026-07-04,
  revised 2026-07-06 on Ollama 0.31.1): decision 30's "disable thinking" holds for
  EXTRACTION only (`think: false` + schema-constrained decoding — grammar keeps
  residual reasoning out of the JSON). For SYNTHESIS the setting is `think: TRUE` —
  not false (backfires on 2026 qwen3 builds: the model reasons INLINE in
  `message.content` where no tag-stripper can catch it) and not unset either:
  ai-sdk-ollama's `reasoningEnabled` follows the SETTING, so with `think` unset,
  qwen3's separated `message.thinking` chunks are DROPPED before they become stream
  parts, and a think phase longer than the inactivity window reads as a watchdog
  stall — observed live 2026-07-06, killing two healthy runs at exactly 300s.
  `think: true` keeps the same message.thinking separation while forwarding
  `reasoning-delta` parts. Correspondingly, the provider's `synthesisStream` consumes
  `streamText().fullStream`, NOT `.textStream`: text deltas yield text, reasoning
  deltas yield `""` (pure watchdog-progress markers — `stripThinkStream` filters
  empties before any consumer), error parts rethrow, abort parts throw the signal's
  reason. `thinkStrip.ts` remains as belt-and-braces for models emitting literal
  tags. Don't "simplify" the two instances back into one, and don't switch back to
  `textStream` — separated thinking must stay visible to the watchdog (risk 17).
- **`num_ctx: 8192` is pinned on both Ollama model instances** (increment 7): Ollama's
  out-of-the-box context is 4096 tokens and it CONTEXT-SHIFTS oversized prompts
  silently (observed live: "slot context shift, n_discard = 2045" while a section
  prompt generated — half the KV cache thrown away mid-stream). The app's prompt
  budget (extraction rawText ≤ 20k chars ≈ 5k tokens; synthesis prompts ≈ 2k tokens
  after the risk-14 cap lowering) assumes the 8k window PLAN.md risk 14 designs for.
  `OLLAMA_NUM_CTX` is exported from `createModelProvider.ts`; wiring tests pin it on
  both instances.

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
- **Increment-6 review pass 2 hardening** (commit-6da77a1 review; 8 fixed, 2 accepted):
  (A, HIGH/SSRF) the private-host guard from pass-1 covered only DISCOVERED tier-2/3
  links — tier-1 candidates and slug guesses built from `profile.domain` bypassed it,
  and `deriveDomain` admits any alphabetic-TLD host (`careers@it.corp` → fetch
  `https://it.corp/…`). Fixed by relocating `isPublicHttpHost` down into
  `candidateUrls.ts` (single source of truth, no import cycle) and filtering
  `tier1Candidates` AND `slugGuessCandidates` through it, so the whole enricher can
  only ever fetch public hosts. (C) a discovered/guessed URL that redirects onto a
  page an EARLIER tier already cited was re-fetched and flipped a later tier to a
  false `found`; the enricher now carries a cross-tier `cited` urlKey set and skips
  such a fetch (`empty_content`, "already cited by an earlier tier"). (D) `foldTier`
  deduped sources by raw string — now by `urlKey`, so `/careers` vs `/careers/`
  redirect variants collapse to one source. (F) `CompanyEnricher.ts` (244 lines,
  22% over the ~200 ceiling) was split: `tierDispatch.ts` now owns
  `dispatchTier`/`attemptCandidate`/`sourceLabel` and the candidate-level guards
  (budget, name match, cross-tier dedup) + the `EnricherDeps`/`EnricherOpts`/
  `EnrichmentEvent` types (re-exported from `CompanyEnricher` for the pipeline/tests);
  the loop file is now 138 lines. Also hardened `dispatchTier`'s allSettled
  rejected-arm to PAIR its step (`step.finished`) before folding a network skip, so a
  future throwing fetcher can't orphan a spinner through `run.completed` (§3
  guarantee 3). (G) `StepRow` now surfaces `skip.detail` as a hover `title` — the
  taxonomy's honesty channel (name-mismatch/cross-tier `empty_content` details) was
  never rendered anywhere. **Accepted, not fixed, with rationale:** (B) the client's
  single `budgetNotice` slot lets a `wall_clock` frame overwrite a `fetches` frame in
  a rare both-kinds run — but PLAN.md §6 explicitly specifies the single-slot shape,
  and each skipped tier's own dashed "skipped — budget" chip carries the honest
  per-tier status independently, so no false state renders (2/3 verify lenses
  refuted on plan-authority + no-material-harm). (E) `looseNameMatch`'s
  hostname-echo strip can under-match a company literally named with a TLD
  ("Booking.com") on the slug-GUESS path — but under-claiming (honest `not_found`)
  is the safe direction per risk 4, it affects only the fallback guess path, and the
  misleading detail isn't user-facing beyond the hover tooltip; sibling to the
  documented github slug-echo residual. `tierDispatch.ts` is a pre-split not in the
  PLAN.md tree (200-line ceiling).

- Increment-7 pre-splits, not in the PLAN.md tree (200-line ceiling):
  `src/domain/synthesis/sectionSources.ts` (source classification, per-section
  ranking, excerpt caps) and `synthesisTestKit.ts` (interface-typed stream-capable
  model stub — the layering rule bans FakeModelProvider from domain tests, the
  extractorTestKit precedent). The watchdog-stall pipeline composition test lives in
  `src/providers/model/pipelineStall.test.ts` because domain tests may not import
  the real watchdog. Excerpt caps are named constants in `sectionSources.ts`
  (risk-14 knobs), LOWERED after live qwen3:4b testing: SECTION_EXCERPT_CAP 2500
  chars, HOOK_EXCERPT_CAP 1500, ≤ 2 web sources per section + the listing, ≤ 5 hook
  sources — the first sizing (4k × 3+1) context-shifted on Ollama's 4096 default and
  cost minutes of CPU prefill dead air.
- Per-section confidence rules (increment 7 — PLAN.md leaves the mapping open):
  `high` needs a section-RELEVANT non-listing source — stack counts github/blog/
  careers-or-jobs pages (a bare homepage would over-claim a stack badge),
  team-signals counts about/careers/jobs/team pages only, recent-launches counts
  blog/changelog/news ONLY and is `none` without them (a listing snapshot cannot
  evidence recency — never listing-backed); seniority-fit is ALWAYS `low`
  (inherently listing-grounded). what-they-do/seniority-fit treat the listing as
  always-relevant; product-area/stack/team-signals require the matching extracted
  optional (productArea/namedTechnologies/teamSignals) for `low`. Ranking tokens
  match subdomain labels + path, never the registrable domain (review finding:
  productboard.com must not rank "product" everywhere).
- Hook grounding (increment 7): the model emits raw `sourceUrls` copied from the
  numbered excerpts; domain code maps them back through `urlKey` to refs the run
  actually holds and DROPS hooks whose every citation is unknown (decision 18).
  Confidence is computed (any web ref → high, listing-only → low), never
  model-reported. The model-facing schema tolerates up to 10 raw hooks; survivors
  are capped at 3 AFTER grounding, deduped by trimmed text. An ALL-dropped batch
  finishes the hooks step as an `empty_content` skip whose detail names the drop
  (§4 drop-visibility); a partial drop finishes `ok` — the ok arm of step.finished
  has no detail channel (§5 schema governs), the surviving count is visible via
  hooks.completed, and per-hook drop counts stay server-side. A hooks-stage
  EXTRACTION_FAILED is caught and degrades to `hooks: []` with the same honest skip
  shape (zero hooks is legal per §3; a run.error would discard an already-streamed
  briefing) — aborts and the watchdog's INTERNAL stall still rethrow, and the open
  step is paired by the pipeline's terminal teardown.
- Synthesis details (increment 7): a sourced section whose stream yields only
  whitespace gets canned EMPTY_STREAM_TEXT content (schema needs min(1); named as a
  model shortfall, distinct from the `none` copy). Section synthesis and hook
  extraction run at temperature 0 with NO maxOutputTokens (qwen3 thinking tokens
  would count against a ceiling and truncate real output). The client reducer
  closes open SECTIONS (done: true, partial text kept) in all three terminal arms
  — aborted, transport_error, run.error — because sections have no server-side
  pairing (§3 guarantee 3 covers steps only) and a caret must never outlive the
  run. Page titles/labels AND urls are fence-neutralized in synthesis prompts, and
  `neutralizeFences` collapses whole bracket runs as a fixed point ("SOURCE>>>>"
  must not regenerate a live closer).

- **`deriveDomain` gained a fourth, lowest-priority candidate** (increment 8,
  live-proof-driven): the ONE distinct non-denied URL host in the pasted
  rawText. qwen3:4b reproducibly omits `domain` at temperature 0 even for an
  explicit "Company website: https://…" line (live-observed 2026-07-06), which
  left paste runs enrichment-less and inferred-email-less. The sole-host rule
  invents nothing (the URL literally appears in the listing); several distinct
  hosts stay ambiguous ⇒ absent, and denied hosts never break uniqueness.
  Paste path ONLY — a fetched page's cleaned text is third-party material.
- Increment-8 pre-splits, not in the PLAN.md tree (200-line ceiling):
  `src/providers/contact/contactCandidates.ts` (the pure half of
  PublicSourceContactSurfacer: people grounding, listing candidate, careers-ref
  picking) + `contactTestKit.ts` + the `.people.test.ts` split;
  `src/domain/contact/contactPrompt.ts` (the people-extraction template lives
  beside its stage — prompts.ts keeps listing/section/hook/draft and now exports
  `neutralizeFences` + `fencedSources` for it); `src/components/sseClient.ts`
  (the ONE client SSE pump — useAnalysisRun and useDraftRun share it),
  `useDraftRun.ts` (pure exported `draftReducer` + the hook), `draftHandoff.ts`
  and `contactRequest.ts` (pure, unit-tested client helpers).
- **`ContactSource.find` stays §4.3-verbatim**; its `coverage` param is typed as
  the WIRE coverage (`ContactRequest["coverage"]`), never `EnrichmentResult` —
  extracted page text does not round-trip (decision 19). Budget, cancel, and the
  per-channel `onTried` sink arrive via the impl's constructor deps (the StepEmit
  pattern), so `sourcesTried` ids are the LOOKUPS actually tried: `listing`,
  `careers`, `github` (derivation channels aren't "tried"; github is omitted —
  not "skipped" — for non-engineering roles, and `isEngineeringRole` matches
  role TITLES only: bare `data`/`security` tokens and the namedTechnologies
  catch-all admitted "Data Entry Clerk", review finding). The contact budget is
  `CONTACT_MAX_FETCHES = 3` / `CONTACT_DEADLINE_MS = 30_000` — constants in
  `domain/contact/ContactSurfacer.ts`, not env knobs.
- Stage-4 people extraction is ONE `extract()` over fenced numbered sources
  (listing rawText + the re-read careers page) rather than a careers-only call —
  fewer model calls on CPU. Grounding is decision-18 twice over: a person whose
  verbatim `sourceUrl` doesn't map (urlKey) to a held excerpt is dropped, and a
  person's `email` survives ONLY if it literally appears in an excerpt's text
  (review HIGH: a hallucinated address would wear the `public` badge and bypass
  decision 28's accept-click into mailto; ungrounded emails degrade to the
  honestly-dashed inferred-email guess). `contactExcerpt` keeps head AND tail
  (contact info clusters at the end of listings); `promptRef` clips
  client-supplied ref label/url BEFORE both the prompt and the grounding map see
  them, so they agree byte-for-byte. A stage-4 EXTRACTION_FAILED degrades to
  zero people, never a dead search; aborts rethrow.
- `listingCandidate` falls back to the rawText's one UNAMBIGUOUS email when
  `applicationContact` carries no email shape — live-observed: qwen3:4b garbled
  "recruiting@driftlock.io" into "recruiting@dr:driftlock.io" at temperature 0,
  reproducibly. Several distinct emails in the text ⇒ no fallback (picking one
  would be a guess wearing `public`). Spec §6.1 grounds this: the value must
  literally appear in the pasted listing.
- SSRF posture on `/api/contact` (client-supplied coverage): careers/github refs
  are re-filtered through `isPublicHttpHost` before dialing, github refs are
  NORMALIZED to the owner page via `linkDiscovery.githubOrgUrl` (org-page-only
  scope enforced mechanically — a repo/commit path in coverage cannot widen it),
  and BOTH fetch sites re-check the redirect's FINAL host post-fetch
  (`isPublicFinalPage`; off-github redirects likewise) — content from a
  non-public final host becomes an `empty_content` skip and is never used
  (review HIGH; the request-time guard alone missed 30x redirects).
  `pickCareersRef` matches whole path segments, never substrings
  ("/blog/steve-jobs-tribute" is not a careers page — review finding).
- **`pageSourceRef` is the ONE CleanPage→SourceRef factory**, moved to
  `src/shared/schema/fetch.ts` (the `pastedListingRef` precedent): tierDispatch
  and the contact providers had grown divergent copies of the title-clip +
  host+path-fallback rule (review finding). `MAX_SOURCE_LABEL_CHARS` lives there.
- NoteDrafter (increment 8): `runDraft` mirrors `runAnalysis` — synchronous
  `draft.started` at seq 0, silent-return-on-abort, and the thrown-error →
  `run.error` mapping is the shared `toRunErrorEvent` now exported from
  `domain/pipeline/errors.ts` (AnalysisPipeline uses the same one). Client-
  supplied inputs are capped: `DRAFT_MAX_HOOKS = 3` applied ONCE at entry (the
  prompt and groundedHooks must agree on what was offered), hook text/basis
  clipped at 500 chars, company/role fence-neutralized + clipped in the prompt
  (review findings). Synthesis rules carry over: temperature 0, NO
  maxOutputTokens, whitespace-only stream ⇒ canned `EMPTY_DRAFT_TEXT`. The
  subject is mechanical (`${role} at ${company}`) — no model call, nothing to
  fabricate. `groundedHooks` is computed mechanically (a hook counts as
  grounded when ≥ half its significant words appear in the body) and entries
  are VERBATIM offered-hook texts, so the §7 subset invariant holds by
  construction.
- Draft/contact client wiring: `draftReducer` inherits the run reducer's guards
  (seq watermark, phase gate, canonical body replaces the streamed buffer;
  `aborted` keeps partial text and returns to idle). `useDraftRun` aborts its
  stream on unmount (review finding: a mid-draft "Analyze another listing" left
  the server generating with nothing listening). `DraftNotePanel` is keyed by
  the SELECTED CONTACT in AnalyzeView (review finding: a note drafted greeting
  contact A must not pair with contact B's mailto), and the guess-accept is
  keyed by candidate identity — switching candidates revokes it with no
  effect-driven reset. `mailtoHref` keeps the recipient's `@` literal (RFC 6068
  forbids %40 in the addr-spec — review finding). ContactPanel mounts only
  after `run.completed` (decision 27) and aborts its in-flight request on
  unmount; the empty-result copy renders `sourcesTried` ("Checked the listing,
  the careers page, GitHub — no contact found."), per §6 shown only when empty.

- **`PageFetcher` gained an optional `cached?(url): Promise<CleanPage | null>` peek**
  (increment 9, deviation from §4.2's fetchClean-only "types only" interface — the
  `CleanPage.links` precedent): §4's jointly-pinned budget rules ("cache hits bypass
  acquisition entirely", tokens "never refunded") plus §7.9's "hits bypass budget +
  limiter" are unsatisfiable through `fetchClean` alone, because acquisition is
  caller-side and pre-dispatch. Every fetchClean call site (tier dispatch, Stage-1
  listing fetch, contact careers re-read, github signal) peeks BEFORE `tryAcquire`
  via the shared never-throw `peekCached` helper — `src/domain/pipeline/cachePeek.ts`,
  a pre-split not in the PLAN.md tree — and serves a hit with no token, no limiter
  slot, no network. Gate 0 INSIDE fetchClean remains (write-through + the fallback
  for non-peeking callers and peek→dispatch races; a gate-0 hit does NOT refund the
  caller's already-counted token). Cached pages face every candidate-level guard a
  fresh page faces — cross-tier dedup, loose name match, isPublicFinalPage, the
  off-github redirect refusal — pinned by tests. `FakePageFetcher` gained
  `setCached`/`peeks`; `scripts/try-cache.ts` (drives /api/analyze through the real
  parseSse + runReducer, timestamping frames) is a 4th smoke script not in the §2
  tree.
- **`JsonFilePageCache.set` writes under BOTH `sha256(url)` and `sha256(finalUrl)`**
  when a redirect renamed the page (deviation from decision 14's single
  `{sha256(url)}.json`): enrichment re-runs look up by the REQUESTED candidate URL,
  but `/api/contact` re-reads look up by the SourceRef they hold, which carries the
  FINAL url (`pageSourceRef`) — without the alias, the plan's "cache-backed
  PageFetcher re-read" would never hit on redirect-renamed pages (trailing-slash
  redirects being the common case). Corrupt/stale/missing/unreadable = miss, never a
  throw; a FUTURE `fetchedAt` is treated as corrupt rather than fresh (a get() that
  kept hitting would prevent the very refetch whose set() would fix the entry).
  Skips are never cached — a 404 today retries tomorrow.
- **Cache I/O is signal-raced, never awaited unboundedly** (increment-9 review,
  CONFIRMED finding): peeks run before a token exists, and fs reads are not
  cancellable, so a pathologically stalled disk would have held a run open past the
  wall-clock ceiling decision 15 promises. `settleByAbort` (in `cachePeek.ts`) races
  cache work against a signal — peek call sites use the run/contact budget's
  `deadlineSignal`, the fetcher's gate-0 read and write-through use `token.signal` —
  resolving to a miss (or skipping the write-wait) on abort, with both arms of the
  abandoned promise handled so a late failure can't become an unhandled rejection.
  Related kind-truthfulness fix in `CompanyEnricher`: a tier stopped because
  `remainingMs()` hit zero DURING the peek yield (before the route's deadline timer
  fires) now reports `budget.exhausted { kind: 'wall_clock' }`, not a false
  `'fetches'`.
- **Increment-9 accepted residuals** (review findings refuted 2/3 on plan
  authority, recorded): (a) warm-run robots staleness — gate 0 serves a ≤24h-old
  page without re-consulting robots.txt (the plan pins cache BEFORE robots, and
  decision 14 pins the TTL), and via the finalUrl alias a same-origin
  robots-disallowed URL that a redirect landed on can render found+cached on a warm
  run where the cold run showed `robots_disallowed`; the cache never stores content
  any gate refused at fetch time, and entries age out in 24h. (b) `PAGE_CACHE_DIR`
  is `process.cwd()`-anchored (decision 14 pins the relative path; cwd is apps/web
  for every documented launch) — hardened with a root-anchored `/data/` .gitignore
  safety net so a repo-root launch cannot turn page snapshots into a commit. The
  composition-root wiring and the client `cached`-tag propagation are now both
  pinned by regression tests (the other two CONFIRMED findings — a cacheless revert
  of `deps.ts` and a deleted `cached: event.cached` line each previously kept the
  whole suite green).

- **`scripts/try-walkthrough.ts` is a 5th smoke script not in the §2 tree**
  (increment 10; the try-cache.ts precedent): it drives the whole spec-§10 chain
  — text-paste /api/analyze → opt-in /api/contact → streamed /api/draft →
  mailto: — through the real client machinery (parseSse, runReducer,
  buildContactRequest, draftReducer, mailtoEmail/mailtoHref) with 13 in-driver
  PASS/FAIL assertions; exit 0 only if every §10 link held.
- **`src/providers/search/SearchProvider.ts` was created by increment 10** (the
  errors.ts claim precedent — the PLAN.md tree assigns it no increment):
  decision 32 pins it as shipping ("referenced by nothing") and the eslint
  layering allowlist already sanctioned its import path, but no increment had
  created it — caught by the increment-10 README review as a HIGH finding (the
  README's architecture tree named a file a fresh reader couldn't find).
  Types-only, still referenced by nothing.
- **Increment-10 accepted residuals** (README wording scoped to match the code;
  code deliberately unchanged in a README increment — v1.1 hardening
  candidates): (a) the enrichment path has NO final-host public re-check after
  redirects — `isPublicFinalPage` guards only /api/contact's two fetch sites,
  so a public enrichment candidate that 30x-redirects to a private host IS
  dialed (fetch `redirect: "follow"`) and its content can be used, cited, and
  cached; the request-time `isPublicHttpHost` filter is universal, and redirect
  landings get only the robots re-check + sign-in-wall refusal. (b) the listing
  contact candidate accepts `applicationContact`'s email on shape-validity
  alone (the `soleEmail` rawText fallback engages only when the garble breaks
  the email shape), so a shape-preserving qwen3 garble could wear `public`
  without appearing verbatim in the listing. (c) Next.js anonymous telemetry is
  not disabled repo-side; the README privacy section discloses it and points at
  `npx next telemetry disable`.

- Increment-11 pre-splits and deviations, not in the PLAN-RESUME.md §2 tree
  (200-line ceiling / thin-routes rule): `src/domain/profile/ResumeImportPipeline.ts`
  (`runResumeImport` + `toImportedEntries` — the tree assigns the import
  orchestration to no file, and business logic can't live in the route; the
  NoteDrafter shape), `src/components/resume/profileEditorState.ts` (+test; the
  pure §6 editor-contract transitions — the runState/runReducer split),
  `useMasterProfile.ts` (load/save/merge lifecycle hook), `IdentityFields.tsx`.
  `GenOpts` gained optional `streamProgress?: boolean` (decision 58 as a
  per-call flag, not a second interface method — FakeModelProvider untouched).
  `profileImport.ts` ships only the resume-import subset in increment 11 (the
  GitHub schemas land with their consumer in 12 — no-scaffolding rule), and
  the §6 chips row arrives with its first chip (GitHub, increment 12) — the
  provider chip lives inside ListingInputForm and extracting it is not
  increment-11 scope. The deps.test profile-store wiring pin is STRUCTURAL +
  read-only (real class, real PROFILE_DIR, TS-private field read) rather than
  a write-sentinel: the store has exactly ONE file, so a sentinel write would
  clobber a real user profile on every test run — the live driver's PUT→GET
  is the behavioral half. `scripts/try-import.ts` (6th smoke script,
  try-cache precedent) sets `process.exitCode` instead of `process.exit()` —
  a hard exit races undici socket teardown on Windows (libuv
  UV_HANDLE_CLOSING assert) and turns green runs into exit 127.
- Import-grounding semantics pinned beyond the plan text (increment 11,
  review-driven): the schema-walk gate visits EVERY string/string-array field
  generically (a future ImportExtractionSchema field is gated automatically);
  fatal-key failures (org/role/name/school) drop the entry but the walk still
  names every other failing string (F3); `dateTokensAppear` requires
  whole-token membership (digit runs via `\p{Nd}`, months matched across
  abbreviation forms, symbols-only dates fall back to substring — never a
  vacuous pass) (F2); blank optionals normalize to absent silently (the qwen3
  ""-fill artifact); a model-invented skills category reverts to the
  mechanical `IMPORT_FALLBACK_CATEGORY` ("Skills") with the invention
  reported; `keptIndices` keep every report path in the ORIGINAL extraction's
  index base (F8); grounding runs against EXACTLY the capped slice the model
  saw. `mergeImportedEntries` returns the profile UNCHANGED on a zero-add
  merge (F12) and never aliases imported groups (F4).

## Commands

All in `apps/web/`: `npm run test` (vitest), `npm run lint`, `npm run build`,
`npm run dev`.
