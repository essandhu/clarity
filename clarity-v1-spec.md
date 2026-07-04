# Clarity — v1 Build Spec

A **local-first, free** tool that turns a job listing into an interview-ready briefing, a
set of specific outreach hooks, a best-effort contact, and a tailored draft note — so a job
seeker can research a role and reach the right person with something specific to say.

This document is the build spec. It is written to be handed to Claude Code as the source of
truth, and to seed the eventual repo README. Build in the increments listed under **Build
Sequence**; do not build everything at once.

---

## 1. Product goals & non-negotiables

**Goal:** Compress the tedious, high-value research step of a job search — "what does this
company actually do, what should I say, and who do I say it to" — into one local tool that
anyone can clone and run for free.

**Non-negotiables (these constrain every design decision):**

1. **Free and shareable.** No paid SaaS dependency may gate core functionality. The only
   metered cost is the LLM, which is either the user's own API key or a fully local model.
2. **Local-first.** Runs entirely on the user's machine. A user's job-search activity — which
   companies they target, what they draft — never leaves their machine. This is a privacy
   feature, not just a cost decision, and should be stated as such in the README.
3. **Degrades honestly.** Every enrichment source is optional and independently skippable. A
   sparse company (e.g. a 20-person startup with only a listing) still yields a complete,
   well-structured result scoped to what is real. The tool **reports its own coverage** and
   never fabricates or presents a guess as a fact.
4. **The listing is the unit of input**, never the company. Every role has a listing; not every
   company has an engineering blog. Starting from the listing is what makes the tool
   generalize across companies of any size.

**Explicit non-goals for v1:** no hosted backend, no user accounts, no database server
(local file storage only), no bulk email sending, no paid contact-enrichment API, no verified
email lookup (see §7).

---

## 2. Architecture overview

Clean separation between **domain logic** (the pipeline and its rules) and **infrastructure**
(model calls, HTTP fetching, storage). Business logic must not live inside UI components or
Next.js route handlers; route handlers are thin adapters that call into the domain layer.

Providers (model, contact discovery, optional web search) are **pluggable interfaces** so the
tool is not hard-bound to any single vendor and can run fully offline on a local model.

```
apps/web (Next.js App Router, TypeScript)
├── app/
│   ├── page.tsx                     # main UI shell
│   └── api/
│       ├── analyze/route.ts         # streams the pipeline run (SSE)
│       └── contact/route.ts         # opt-in contact surfacing step
├── src/
│   ├── domain/                      # framework-independent business logic
│   │   ├── listing/                 # extraction: raw listing -> ListingProfile
│   │   ├── enrichment/              # tiered company enrichment + coverage
│   │   ├── synthesis/               # briefing + hooks + draft note
│   │   └── contact/                 # public-source contact surfacing
│   ├── providers/                   # pluggable infrastructure behind interfaces
│   │   ├── model/                   # ModelProvider: cloud BYO-key | local (Ollama)
│   │   ├── fetch/                   # PageFetcher: robots-aware, timeout, retry
│   │   └── contact/                 # ContactSource implementations
│   └── shared/schema/               # zod schemas (single source of truth for shapes)
└── data/                            # local cache (gitignored): SQLite or flat files
```

**Naming:** use domain-specific names (`ListingExtractor`, `CompanyEnricher`,
`HookSynthesizer`, `ContactSurfacer`), never `utils` / `helpers` / `common` dumping grounds.
Keep functions under ~50 lines and files under ~200; split when they grow past that.

**Library-first.** Do not hand-roll what a mature library already does well:

- `ai` (Vercel AI SDK) — streaming + a single abstraction over OpenAI, Anthropic, and local
  models. This is also what gives the token-by-token synthesis UI.
- `zod` — validate and enforce the shape of all LLM structured output. LLM extraction output
  must be parsed through zod before any downstream code touches it.
- `@mozilla/readability` + `jsdom` (or `cheerio`) — strip listing/careers pages to clean text.
- `cockatiel` — timeout, retry-with-backoff, and circuit-breaker around flaky fetches. Do not
  write custom retry logic.
- a `robots.txt` parser (e.g. `robots-parser`) — respect crawl rules (see §7).
- `better-sqlite3` — optional local cache. Flat JSON files are acceptable for v1 if simpler.

---

## 3. The pipeline

A single run streams through four stages. Each stage emits progress events the UI renders as
discrete live steps. A **run budget** (max total fetches + a wall-clock ceiling) bounds the
whole thing; any source that exceeds its slice is skipped, not retried forever.

**Stage 1 — Extraction (always succeeds).**
Input: a listing URL or pasted listing text. If a URL, fetch and clean it first. Use the model
to convert the messy, format-varied listing into one consistent `ListingProfile` (see §5),
enforced by zod. This stage is what makes the tool generalize across Greenhouse / Lever /
Ashby / pasted-text inputs. It must succeed even with no network beyond the initial fetch.

**Stage 2 — Company enrichment (tiered, budgeted, best-effort).**
From the company + domain parsed in Stage 1, derive candidate URLs and fetch what exists,
working down priority tiers under the run budget:

- **Tier 0** — the listing itself (already have it).
- **Tier 1** — company homepage / careers / product pages (derive from domain; almost always
  present).
- **Tier 2** — engineering blog, GitHub org, changelog (sometimes present).
- **Tier 3** — recent news / launches (nice-to-have).

Independent fetches run in parallel. Each source is skippable: one dead page never sinks the
run. Every tier's outcome is recorded as coverage (`found` | `not_found` | `skipped_budget`).

> **Free-search note:** v1 derives candidate URLs from the company domain rather than calling a
> paid search API, keeping it free. A `SearchProvider` interface is defined so a search backend
> can be plugged in later without touching the pipeline.

**Stage 3 — Synthesis (streamed).**
Combine whatever was gathered into: (a) a **briefing** (what the company does, product area,
stack, team signals, seniority), and (b) **2–3 referenceable hooks** — specific, true things a
person could open an outreach message with ("they shipped X"; "their eng blog covered
migrating to Y"). Stream this token-by-token. Each briefing section and each hook carries a
**coverage/confidence indicator** and its **source citations**. If a section had no source,
say so ("recent launches: not found") rather than inventing content.

**Stage 4 — Contact surfacing (opt-in, see §6).**
Does **not** run automatically. Renders as a "find a contact for this role" button after the
briefing appears, so any network calls and effort are deliberate and user-initiated.

The draft outreach/application note is generated from the hooks on demand and handed to the
user to send from their own mail client — the app never sends mail (see §7).

---

## 4. Provider interfaces

All three are swappable behind a plain interface. The active implementation is chosen from a
local `.env` file. If a provider is unconfigured, the pipeline degrades (e.g. no model key and
no local model → clear error; no contact source → contact step returns "none found").

### 4.1 ModelProvider (required — cloud BYO-key **and** local model)

```ts
interface ModelProvider {
  id: 'openai' | 'anthropic' | 'ollama' | string;
  // Structured extraction: returns data validated against the given zod schema.
  extract<T>(input: string, schema: ZodSchema<T>, opts?: GenOpts): Promise<T>;
  // Streaming synthesis: yields text chunks for the UI.
  streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string>;
}
```

- **Cloud (BYO-key):** user supplies their own `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Per-run
  cost is cents, on the user's own key — no shared bill, no gate.
- **Local (Ollama):** point at a local model so the tool runs at **zero API cost**. Extraction
  and triage work acceptably on smaller local models; synthesis polish will be lower. This is
  the path for users with no key (including first-time testers). Document the quality tradeoff
  honestly in the README.

The AI SDK gives a unified surface over all three, so a single implementation with a
provider-selection switch covers this — do not write three separate clients.

### 4.2 PageFetcher (required)

```ts
interface PageFetcher {
  fetchClean(url: string, budget: BudgetToken): Promise<CleanPage | FetchSkip>;
}
```

Server-side only (Next.js route handler / server action). Server-side fetching is **required**,
not a preference: browsers cannot fetch arbitrary third-party listing pages (CORS). Wraps
`cockatiel` for per-source timeout + backoff, respects `robots.txt`, sets a descriptive
User-Agent, and rate-limits its own requests. Returns cleaned text via Readability. On failure
returns a typed skip, never throws into the pipeline.

### 4.3 ContactSource (required for v1, public-source only)

```ts
interface ContactSource {
  id: string;
  find(profile: ListingProfile, coverage: EnrichmentResult): Promise<ContactCandidate[]>;
}
```

v1 ships **one** implementation: `PublicSourceContactSurfacer` (see §6). The interface exists so
a paid enrichment provider could be added later behind the same seam — but v1 has **no paid
dependency**.

---

## 5. Core schemas (zod — single source of truth)

Define these in `src/shared/schema/` and derive TS types from them. All LLM output is parsed
through the relevant schema before use.

- **`ListingProfile`** — `{ company, domain?, role, seniority?, namedTechnologies: string[],
  productArea?, teamSignals?, applicationContact?, listingUrl?, rawText }`
- **`EnrichmentResult`** — per-tier `{ tier, status: 'found'|'not_found'|'skipped_budget',
  sources: SourceRef[], extracted: Record<string, unknown> }[]`
- **`Briefing`** — sectioned, each section `{ title, content, confidence: 'high'|'low'|'none',
  sources: SourceRef[] }`
- **`Hook`** — `{ text, basis, confidence, sources: SourceRef[] }`
- **`ContactCandidate`** — `{ name?, role?, channel: 'listing'|'careers'|'github'|'linkedin'|
  'inferred-email', value?, confidence: 'verified'|'public'|'guess', source: SourceRef }`
- **`DraftNote`** — `{ subject?, body, groundedHooks: string[] }`
- **`SourceRef`** — `{ url, label, fetchedAt }`

`confidence` is not decorative — the UI must render it, and nothing labeled `guess` may be
presented as fact.

---

## 6. Contact surfacing (v1, free, public-source only)

Verified email lookup is the one capability that genuinely requires a paid database, so v1 does
**not** claim to do it. Instead it does what public sources allow, always labeled by confidence:

1. **Publicly listed contacts** — recruiter names / application contacts that appear in the
   listing or on the careers page. Confidence: `public`.
2. **Public GitHub signal** — for engineering roles, public profiles / commit metadata may
   surface the right person (or a public email). Confidence: `public`.
3. **Inferred email pattern** — given a domain and a name, guess the format
   (`first.last@`, `first@`, …) and present it **clearly labeled `guess`**, never as fact. Do
   **not** SMTP-probe to "verify" guesses — it gets you rate-limited/blocked and is exactly the
   hope-for-the-best failure mode to avoid.
4. **Right channel over raw email** — often the strongest output is "reach [name],
   Engineering Manager, via LinkedIn" or "apply via this Greenhouse link." Identifying the
   correct person and channel is most of the value and is fully free.

The free tool deliberately shifts weight from "here's their email" toward "here's *who* to
reach, on *which* channel, and *exactly what specific thing* to say" — which is the
highest-converting part anyway.

---

## 7. Legal, privacy & good-citizen constraints

Treat these as first-class design requirements, not footnotes:

- **Send from the user's own client.** The app **drafts** and hands off (open-in-mail / copy).
  It does not bulk-send. This keeps the user a human sending individual, personalized messages
  — the legally clean path *and* the version that actually converts.
- **Minimize retained personal data.** Only surface a work/hiring-context contact. Don't retain
  contacts the user isn't actually reaching out to. No phone numbers — needless for job
  outreach. Be mindful of anti-spam law (CAN-SPAM) and GDPR/UK-GDPR if any contact is in the
  EU/UK.
- **Respect `robots.txt` and rate-limit fetching.** A generalist tool that hits arbitrary sites
  must be a good web citizen. Handle this deliberately in `PageFetcher`.
- **Local-first = privacy.** Reinforce in the README that nothing leaves the user's machine.

---

## 8. Frontend showpieces (the portfolio payload)

These are the interview-relevant surfaces; build them with care, not as afterthoughts:

- **Live agent-step visualization** — each pipeline stage/source renders as a discrete live
  state ("Extracting listing… → Reading careers page… → Found 3 hooks"). This is what pushes
  the tool past a "chat wrapper."
- **Progressive card rendering** — render each finding *as it lands*; don't block on the full
  run. This is the real solution to multi-step latency: a 20s run *feels* fast when results
  populate progressively.
- **Streaming synthesis** — token-by-token briefing/hook generation.
- **Source citations** — every claim links back to where it came from ("source highlighting"
  is the polish that separates this from terminal output).
- **Cancellation** — the user can abort a long multi-step run once they've seen enough.
- **Coverage/confidence indicators** — honest per-section reporting, surfaced visually.

---

## 9. Build sequence (increment order for Claude Code)

Build and verify each increment before starting the next. Do not scaffold everything at once.

1. **Skeleton + schemas.** Next.js App Router app, `src/` domain/provider/schema layout, all
   zod schemas in §5. No logic yet.
2. **ModelProvider.** Unified AI SDK implementation with provider switch: cloud BYO-key +
   local Ollama. Prove `extract()` and `streamSynthesis()` against a trivial prompt.
3. **PageFetcher.** robots-aware, `cockatiel` timeout/backoff, Readability cleaning, typed
   skips.
4. **Stage 1 — extraction** end to end: paste text OR URL → validated `ListingProfile`.
5. **`/api/analyze` streaming route + UI shell** with live agent-step visualization and
   cancellation, wired to Stage 1 so streaming works before enrichment exists.
6. **Stage 2 — tiered enrichment** with budget, parallel fetches, coverage reporting.
7. **Stage 3 — synthesis:** streamed briefing + hooks with confidence + citations; progressive
   card rendering.
8. **Stage 4 — contact surfacing** (`PublicSourceContactSurfacer`) as an opt-in step, plus the
   on-demand draft note with hand-off to the user's mail client.
9. **Optional local cache** (SQLite/flat files) keyed by company to make re-runs near-free.
10. **README pass** — reuse this spec; document setup, the BYO-key vs local-model tradeoff, and
    the privacy/good-citizen posture.

---

## 10. Definition of done for v1

A user with no API key can clone the repo, point it at a local model, paste (or link) a job
listing, watch the pipeline stream live, get an honest briefing with cited hooks, optionally
surface a public contact + channel, and copy a tailored draft note into their own email client
— for any listing, from a 20-person startup to a large company, degrading honestly where
sources are thin.
