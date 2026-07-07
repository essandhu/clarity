# Clarity

Paste a job listing, get an interview-ready briefing with cited outreach hooks —
**local-first and free**.

Clarity turns one job listing into the research you'd otherwise do by hand before
applying or reaching out:

- **A structured profile** of the role — company, seniority, named technologies,
  product area — extracted from the pasted text or a listing URL.
- **A briefing** on the company (what they do, product area, stack, team signals,
  recent launches, seniority fit), streamed token by token, with a confidence badge
  and source citations on every section.
- **2–3 outreach hooks** — specific, true things you could open a message with,
  each citing the page it came from. Hooks whose citations can't be verified
  against pages the run actually fetched are dropped, not shown.
- **An opt-in contact search** over public sources only (the listing itself, the
  careers page, a public GitHub org), returning candidates labeled `public` or
  `guess` — never a guess dressed up as a fact.
- **A draft outreach note**, streamed as it's written, that you copy or open in
  **your own** mail client. Clarity never sends mail.

The listing is the unit of input, never the company: every role has a listing, so
the tool works for a 20-person startup with no engineering blog just as well as for
a big company — it just honestly reports thinner coverage.

## Quickstart

You need **Node.js ≥ 22** (Node 24 LTS recommended) and either
[Ollama](https://ollama.com) (free, local, no key) or your own OpenAI/Anthropic API
key.

```bash
git clone https://github.com/essandhu/clarity.git
cd clarity/apps/web
npm install
cp .env.example .env.local        # Windows PowerShell: copy .env.example .env.local
# edit .env.local — pick ONE provider (see below); for the free path:
#   MODEL_PROVIDER=ollama
npm run dev
```

Open <http://localhost:3000>. The chip next to the input tells you which provider
the app actually resolved (`Ollama · local`, `OpenAI · your key`,
`Claude · your key`) — if it warns `Ollama · not reachable`, Ollama isn't running
or `OLLAMA_BASE_URL` points at the wrong place.

## Your first run — no API key required

This is the intended first experience, verified end to end on a machine with no
cloud key:

1. **Install Ollama** from <https://ollama.com> (tested with Ollama 0.31) and pull
   the default model:

   ```bash
   ollama pull qwen3:4b
   ```

2. In `apps/web/.env.local`, set:

   ```
   MODEL_PROVIDER=ollama
   ```

   (`OLLAMA_BASE_URL` defaults to `http://localhost:11434` and `OLLAMA_MODEL`
   defaults to `qwen3:4b` — you only set those to override.)

3. `npm run dev`, open <http://localhost:3000>, and confirm the chip reads
   **Ollama · local**.

4. **Paste a listing** (the *Paste text* tab) and click **Analyze listing**. Any
   listing works; if you want a ready-made one, paste the contents of
   `apps/web/fixtures/listings/sparse-startup.txt` — a deliberately sparse
   startup listing that shows how the tool degrades honestly when the listing is
   the only source.

5. **Watch the run stream.** Each stage renders as live steps: extraction, then
   tiered company enrichment, then the briefing sections streaming one at a
   time with their confidence badge and citations mounted **before** the text
   arrives. With a listing that names a company site, the enrichment stage
   fetches homepage / careers / blog / GitHub pages as individual rows —
   skipped or dead pages show as honest skip chips, and cached pages are tagged
   *cached* on re-runs; with the sparse fixture (no company site named), the
   tiers instead land as honest not-found chips with zero fetches. On a paste-only run, sections grounded solely in the listing
   cite a non-link **“Pasted listing text”** chip; sections with no source at all
   say **“Not found in available sources.”** instead of inventing content. You
   can cancel at any point and keep what has already streamed.

6. **Optionally click “Find a contact for this role.”** Nothing contact-related
   runs before that click. You get up to a handful of candidates — a contact
   listed in the posting (`public`, citing where it appeared), a person found on
   public pages with the right channel to reach them, and/or an inferred email
   pattern that is always labeled **guessed — unverified**. The response also says
   which sources were tried (listing / careers page / GitHub) even when nothing
   was found.

7. **Click “Draft outreach note.”** The note streams in grounded on your
   hooks; then hit **Copy note** or **Open in mail**. A guessed email never
   enters the `mailto:` link unless you explicitly click **Use this guessed
   address** first — until then the mail button reads *Open in mail (no
   address)* rather than presenting a guess as fact.

**Set your expectations for local speed honestly.** `qwen3:4b` is a *thinking*
model, and on a CPU-only laptop its reasoning phases dominate: the sparse
paste-only walkthrough above has been measured completing its briefing and hooks
in about five minutes with the draft note taking another fifteen, but reasoning
scales with source material — on source-rich runs, single sections have been
observed thinking for tens of minutes and a full keyless run can stretch to
hours. A GPU-backed Ollama or a cloud key brings this down dramatically. Clarity
is built so that slow-but-healthy local generations are never killed by a timer
— see the design notes below — and progressive rendering means you see
extraction, coverage, and early sections long before the run finishes.

## Model providers

One `ModelProvider` implementation runs all three backends through the Vercel AI
SDK; you choose with env vars in `apps/web/.env.local`:

| Provider | Set | Model used |
| --- | --- | --- |
| **Ollama** (free, local) | `MODEL_PROVIDER=ollama` | `OLLAMA_MODEL` (default `qwen3:4b`) |
| **OpenAI** (your key) | `OPENAI_API_KEY=sk-…` | `gpt-5-mini` |
| **Anthropic** (your key) | `ANTHROPIC_API_KEY=sk-ant-…` | `claude-sonnet-5` |

If `MODEL_PROVIDER` is unset, the app auto-detects from present keys (OpenAI
first, then Anthropic). Ollama is never auto-selected — it has no key, so you opt
in explicitly. Cloud model ids are deliberately constants, not knobs. Per-run
cloud cost is cents, on your own key; there is no shared service and no gate.

**The local-model tradeoff, honestly.** Extraction — turning a messy listing into
the structured profile — works acceptably on small local models: Clarity uses
Ollama's native JSON-schema-constrained decoding at temperature 0, with exactly
one repair re-prompt on a validation failure. Synthesis polish is where you feel
the difference: briefing prose and the draft note from a 4B model are serviceable
but noticeably below cloud quality, and CPU-only generation is slow. Known-good
tags:

- `qwen3:4b` — the default, and the model the end-to-end keyless walkthrough was
  verified with. It's a thinking model; Clarity keeps its reasoning phase off your
  screen while still treating it as liveness (so long thinks don't trip the stall
  watchdog), and pins an 8k context window on its Ollama calls, matching the
  app's prompt budget (Ollama's out-of-the-box 4k default would silently drop
  half the prompt).
- `llama3.2:3b` — smaller and faster, no thinking phase.
- `phi4-mini:3.8b` — similar class.

If a run fails with `EXTRACTION_FAILED` on an exotic model, that's the honest
failure mode: the model couldn't produce schema-valid output even after one
repair pass. Try one of the tags above.

## Configuration

Everything is optional except picking a provider. From `apps/web/.env.example`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_PROVIDER` | auto-detect | `openai` \| `anthropic` \| `ollama` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | your own key (BYO-key) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | where Ollama listens |
| `OLLAMA_MODEL` | `qwen3:4b` | any pulled tag |
| `CLARITY_MAX_FETCHES` | `12` (ceiling 20) | max page fetches per run |
| `CLARITY_DEADLINE_MS` | `60000` (ceiling 120000) | wall-clock ceiling on **fetching** |
| `CLARITY_MODEL_INACTIVITY_MS` | `300000` | model watchdog: any model call (an extraction, or a stream making no progress) is aborted after this long without progress |

`GET /api/health` reports the resolved provider (and, for Ollama, reachability of
the configured base URL) — it's what drives the chip, and it never exposes keys.

## Privacy: local-first is the point

Your job-search activity — which companies you target, who you consider
contacting, what you draft — **never leaves your machine**. That's a feature, not
just a cost decision:

- No hosted backend, no accounts, no database server. Clarity itself contains no
  analytics or tracking of any kind — the app is a local Next.js server you run
  yourself. (One framework caveat, stated because this README doesn't hide
  things: Next.js sends anonymous build/dev telemetry to Vercel unless you opt
  out — run `npx next telemetry disable` once if you want that off too.)
- The only outbound traffic is (a) calls to the model provider **you** configured
  — with Ollama that's your own machine (the default `http://localhost:11434`),
  so your listing text, briefing, and drafts never leave it — and (b) plain HTTP
  fetches of public company pages (homepage, careers, blog, GitHub org) during a
  run you started.
- Fetched pages are cached as flat JSON files under `apps/web/data/` (24-hour
  TTL), so a re-run skips refetching: the fetch phase of a warm re-run completes
  in seconds with zero network for cached pages (the model work still runs).
  That directory is gitignored — your research trail can't accidentally end up
  in a commit.
- Contact results are **never persisted** — not to disk, not to the cache. They
  exist only in the response to your click.

## Being a good web citizen

A tool that fetches arbitrary company sites has to behave. Clarity's fetcher, by
construction:

- **Respects `robots.txt`** (RFC 9309), including `Crawl-delay`. Disallowed paths
  surface in the UI as honest "blocked by robots.txt" skips. If a robots file
  can't be fetched due to a server error, Clarity conservatively skips the page
  rather than assuming permission.
- **Rate-limits itself per host** — at most 2 concurrent requests and at least 1
  second between requests to the same host (more if robots asks for it) — with
  timeouts, capped retry backoff, and a per-origin circuit breaker so a struggling
  site is left alone.
- **Identifies itself honestly** with a descriptive User-Agent:
  `ClarityBot/0.1 (+https://github.com/essandhu/clarity; local job-research tool)`.
- **Is budgeted**: a run makes at most `CLARITY_MAX_FETCHES` page fetches (default
  12) inside a hard wall-clock window; the opt-in contact search is separately
  capped at 3 fetches / 30 seconds. Every URL Clarity discovers on its own
  (enrichment candidates, links mined from fetched pages, contact re-reads) is
  filtered to public web hosts before it is dialed — a fetched page can never
  steer which URLs Clarity chooses to fetch toward localhost or intranet
  addresses. Redirect landing pages are re-checked against the target's
  robots.txt and refused if they land on a sign-in wall, and the opt-in
  contact search additionally discards any content whose redirect landed on a
  non-public host.

And on the outreach side:

- **No mail is ever sent.** Clarity drafts; you send, individually, from your own
  client via `mailto:` or copy-paste.
- **No SMTP probing** to "verify" guessed emails — guesses stay labeled guesses.
- **No phone numbers.** Phone-shaped strings are stripped from contact results;
  they're needless for job outreach.
- **You are the data controller of your own outreach.** Clarity surfaces
  hiring-context contacts from public sources and retains nothing, but what you
  send, to whom, is yours — anti-spam law (CAN-SPAM) and GDPR/UK-GDPR apply to
  you as the sender, and the individually-written, personalized note this tool
  produces is both the legally sane path and the one that actually converts.

## Reading the output: coverage honesty

Clarity **reports its own coverage instead of papering over gaps**:

- Every enrichment tier lands as a chip: `found` / `not found` /
  `skipped — budget`. A dead careers page is a visible skip row, not silence, and
  never sinks the rest of the run.
- Every briefing section carries a computed confidence badge: **high** (a
  relevant fetched page backs it), **low** (only the listing backs it), or
  **none** — and `none` sections get canned "Not found in available sources."
  copy with **no model call at all**, so there is nothing to hallucinate.
- Confidence is computed by domain code from what was actually fetched — the
  model never gets to grade its own claims.
- Every claim links back to its source; pasted listings are cited as a non-link
  "Pasted listing text" chip. Hooks citing pages the run never fetched are
  dropped server-side.
- Contact candidates are labeled `public` (taken from the listing's stated
  contact or found verbatim in a cited public source) or `guess` (an inferred email pattern, dashed styling, requires
  an explicit accept click before it's usable). v1 never claims a verified email
  — that genuinely requires a paid database, so the tool doesn't pretend.

## Architecture

Next.js App Router app in `apps/web/`, with domain logic strictly separated from
infrastructure (an ESLint layering rule makes `src/domain/**` importing
infrastructure — the AI SDK, jsdom/cheerio, cockatiel, bottleneck, Next.js,
node `fs`, or any provider implementation — a lint failure, not a code-review
hope):

```
apps/web
├── app/
│   ├── page.tsx                  # UI shell
│   └── api/
│       ├── analyze/route.ts      # POST → stages 1–3 (extract → enrich → synthesize) as SSE
│       ├── contact/route.ts      # POST → opt-in Stage 4 (public-source contact)
│       ├── draft/route.ts        # POST → streamed draft note (SSE)
│       └── health/route.ts       # GET  → resolved provider + Ollama reachability
├── src/
│   ├── domain/                   # framework-free business logic
│   │   ├── pipeline/             # orchestration, run budget, typed errors
│   │   ├── listing/              # Stage 1: extraction → ListingProfile
│   │   ├── enrichment/           # Stage 2: tiered, budgeted, parallel fetches
│   │   ├── synthesis/            # Stage 3: briefing + hooks + draft prompts
│   │   └── contact/              # Stage 4: rank/dedupe/cap, email patterns
│   ├── providers/                # pluggable infra behind interfaces
│   │   ├── model/                # ModelProvider: openai | anthropic | ollama
│   │   ├── fetch/                # robots-aware, rate-limited, resilient fetcher
│   │   ├── contact/              # PublicSourceContactSurfacer + GitHub signal
│   │   ├── cache/                # flat-JSON page cache (24h TTL)
│   │   └── search/               # SearchProvider interface only (future seam)
│   ├── shared/schema/            # zod schemas — the single source of truth,
│   │                             #   including the SSE wire protocol
│   ├── server/                   # composition root + SSE encoder
│   └── components/               # the streaming UI (reducer-driven)
└── data/                         # local page cache (gitignored)
```

A run streams over SSE as typed, zod-validated events (`step.started`,
`step.finished`, `synthesis.delta`, `budget.exhausted`, …) with heartbeats,
monotonic sequence numbers, and exactly one terminal event — the client is a pure
reducer over that stream, which is how live agent steps, progressive cards,
cancellation, and honest skip chips all fall out of one mechanism. Stage 4 and
the draft live on separate user-initiated routes, so "opt-in" is structural, not
a convention.

`docs/PLAN.md` is the full implementation plan (decisions, wire protocol,
schemas); `docs/ARCHITECTURE.md` has the same architecture as diagrams;
`clarity-v1-spec.md` is the product spec this README distills.

## Design notes & spec deviations

- **The wall-clock ceiling bounds fetching only (Stages 1–2), not synthesis.**
  The spec says a run budget "bounds the whole thing"; applied literally to model
  calls, that would self-cancel every slow CPU-Ollama synthesis and break the
  keyless path — so it is deliberately not applied there. Instead, synthesis is
  bounded by two things: your cancel button, and a per-stream **inactivity
  watchdog** — if a model stream makes no progress (no token, no reasoning
  delta) for `CLARITY_MODEL_INACTIVITY_MS` (default 5 minutes), the run is
  terminated with an honest error pointing at the likely cause. A
  slow-but-alive synthesis stream is never killed — every token and every
  reasoning delta resets the timer — while a hung call always is, even with
  nobody watching. (The same watchdog also bounds the non-streaming extraction
  call, where the window is a ceiling on the whole call; the default is sized
  generously for CPU-Ollama extraction, which completes in well under a
  minute.)
- **Pasted text is analyzed up to 20,000 characters.** The input box accepts up
  to 50,000, but extraction reads exactly the first 20k (sized to the 8k-token
  context window the local-model path guarantees). For almost all listings this
  is the whole text; for very long ones, trailing content is deliberately not
  analyzed rather than silently truncated mid-model.

## Development

```bash
cd apps/web
npm run test    # vitest — the full unit/protocol suite
npm run lint    # eslint, including the domain-layering rule
npm run build   # next build
npm run dev     # dev server
```

`apps/web/scripts/` has standalone smoke scripts (`try-model.ts`, `try-fetch.ts`,
`try-extract.ts`, `try-cache.ts`) that drive individual layers against live
services via `npx tsx` — useful when validating a new model tag or debugging
fetch behavior.
