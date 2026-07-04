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
      **Deferred verification:** the live `npx tsx scripts/try-model.ts` smoke against
      (a) a cloud key and (b) Ollama `qwen3:4b` — neither a key in `.env.local` nor an
      Ollama install exists on this machine. Run it when one is available, at latest
      with increment 4 (which needs a live model anyway).)
- [x] 3 — PageFetcher + RunBudget (done 2026-07-04: 157/157 tests, lint clean, build
      passes; live `try-fetch.ts` verified all four §7 scenarios — Stripe jobs page
      cleaned, google `/search` → `robots_disallowed`, dead domain → `network` after
      visible retry backoff, 1-fetch budget → `budget_exhausted` with zero network —
      plus a real Greenhouse board through its cross-host redirect. Risk-3 check:
      Greenhouse & Ashby robots allow listing paths for `*`; Lever allows `*` with
      `Crawl-delay: 1` (honored). Adversarial review confirmed 3 findings (non-http
      scheme bypass, crawl-delay/timeout starvation, schema-invalid skip `url`) — all
      fixed with regression tests; see the fetcher-internals deviation bullet below.)
- [ ] 4 — Stage 1 extraction end-to-end ← **NEXT**
- [ ] 5 — /api/analyze SSE route + UI shell
- [ ] 6 — Stage 2 tiered enrichment
- [ ] 7 — Stage 3 streamed synthesis
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

## Commands

All in `apps/web/`: `npm run test` (vitest), `npm run lint`, `npm run build`,
`npm run dev`.
