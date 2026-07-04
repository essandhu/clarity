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
- [ ] 2 — ModelProvider ← **NEXT**. Verifying the smoke script needs either a cloud key
      in `apps/web/.env.local` or local Ollama running with `qwen3:4b` pulled.
- [ ] 3 — PageFetcher + RunBudget
- [ ] 4 — Stage 1 extraction end-to-end
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
  (increment 2 verifies it) and `serverExternalPackages: ['jsdom']` in `next.config.ts`
  (increment 3 verifies it once jsdom is installed).

## Commands

All in `apps/web/`: `npm run test` (vitest), `npm run lint`, `npm run build`,
`npm run dev`.
