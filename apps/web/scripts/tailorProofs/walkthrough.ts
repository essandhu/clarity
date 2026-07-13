// The increment-16 full v1.1 chain (PLAN-RESUME.md §7.16 / spec §10 for the
// resume feature): paste-import → save → GitHub import (1 repo, keyless) →
// tailor (paste role) → toggles/diff → render .tex → compile .pdf, driven over
// the real wire through the REAL client machinery (parseSse + importReducer +
// tailorReducer, the pure applyResumeToggles/wordDiff folds, renderResumeTex,
// pdfPageCount) with in-driver PASS/FAIL checks — the try-walkthrough.ts (v1)
// precedent, grown for the resume feature. The user's stored profile is moved
// aside and restored in finally: the walkthrough builds a throwaway Maya-Chen
// profile from the pinned fixtures.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createSseParser } from "../../src/components/parseSse";
import { pdfPageCount } from "../../src/components/resume/pdfPageCount";
import { applyResumeToggles, emptyToggles } from "../../src/components/resume/resumeToggles";
import {
  importReducer,
  initialImportState,
  type ImportState,
} from "../../src/components/resume/useResumeImportRun";
import {
  initialTailorState,
  tailorReducer,
  type TailorState,
} from "../../src/components/resume/useTailorRun";
import { wordDiff } from "../../src/components/resume/wordDiff";
import { mergeImportedEntries } from "../../src/domain/profile/profileMerge";
import { normalizeForMatch } from "../../src/domain/profile/resumeImportGrounding";
import { escapeLatexText } from "../../src/domain/resume/latexEscape";
import { renderResumeTex } from "../../src/domain/resume/resumeLatex";
import {
  emptyMasterProfile,
  GithubReposResponseSchema,
  ImportedEntriesSchema,
  MasterProfileSchema,
  PipelineEventSchema,
  type ImportedEntries,
  type MasterProfile,
  type PipelineEvent,
  type TailorRoleInput,
} from "../../src/shared/schema";
import { at, check, elapsedSeconds, finish } from "../importProofs/harness";
import { verifyResolution } from "./verify";

const PROFILE_DIR = path.join("data", "profile");
const PASTE_FIXTURE = "fixtures/resume/pasted-resume.txt";
const DEFAULT_ROLE = "fixtures/listings/sparse-startup.txt";

export async function runWalkthrough(opts: {
  base: string;
  githubUser: string;
  rolePath: string;
}): Promise<void> {
  const { base, githubUser } = opts;
  const rolePath = opts.rolePath || DEFAULT_ROLE;

  // Move the user's real profile aside — the walkthrough writes a throwaway one,
  // and the finally below restores it. A hard kill (Ctrl-C / OOM / power loss)
  // skips that finally, leaving the real profile in the aside dir and a throwaway
  // in data/profile; recover from that FIRST so a re-run self-heals instead of
  // renaming onto an existing aside (EPERM on Windows / ENOTEMPTY on POSIX —
  // outside the try/finally, that throw would strand the real profile for good).
  const aside = `${PROFILE_DIR}.walkthrough-aside`;
  if (existsSync(aside)) {
    rmSync(PROFILE_DIR, { recursive: true, force: true }); // an interrupted run's throwaway
    renameSync(aside, PROFILE_DIR); // the real profile, back where it belongs
  }
  const hadProfile = existsSync(PROFILE_DIR);
  if (hadProfile) renameSync(PROFILE_DIR, aside);

  try {
    await health(base);
    const iso = new Date().toISOString();

    // 1) Paste-import: the pasted resume → grounded entries over the live SSE.
    const pasted = readFileSync(PASTE_FIXTURE, "utf8");
    const importEntries = await drivePasteImport(base, pasted);
    if (!importEntries) return finish();
    check("paste import returned experience entries", importEntries.experience.length > 0, `${importEntries.experience.length}`);
    check(
      "every imported entry carries pasted-resume provenance",
      [...importEntries.experience, ...importEntries.projects, ...importEntries.education].every(
        (e) => e.provenance.origin === "pasted-resume",
      ),
    );
    // Representative verbatim spot-check (the exhaustive gate is try-import --paste).
    const haystack = normalizeForMatch(pasted);
    const sample = importEntries.experience[0]?.bullets[0]?.text;
    check(
      "a sample imported bullet is verbatim-grounded in the paste",
      sample !== undefined && haystack.includes(normalizeForMatch(sample)),
      sample,
    );

    // 2) Save: merge into a blank profile and PUT it (disk truth, decision 37).
    let profile = mergeImportedEntries(emptyMasterProfile("Maya Chen", iso), importEntries, iso).profile;
    await save(base, profile);
    profile = await roundTrip(base, profile, "after paste import");

    // 3) GitHub import (1 repo, keyless): stage A list → tick 1 → stage B import.
    const githubEntries = await driveGithubImport(base, githubUser);
    if (githubEntries) {
      check("GitHub import produced exactly 1 project entry", githubEntries.projects.length === 1, `${githubEntries.projects.length}`);
      check(
        "the GitHub project cites its html_url and invents no bullets",
        githubEntries.projects.every(
          (p) => p.provenance.origin === "github-api" && p.provenance.ref?.url === p.url && p.bullets.length === 0,
        ),
      );
      profile = mergeImportedEntries(profile, githubEntries, new Date().toISOString()).profile;
      await save(base, profile);
      profile = await roundTrip(base, profile, "after GitHub import");
    }

    // 4) Tailor (paste role): role text → extract role → select from master.
    const role: TailorRoleInput = { kind: "text", text: readFileSync(rolePath, "utf8") };
    const tailor = await driveTailor(base, role);
    if (!tailor || !tailor.resume || !tailor.coverage || !tailor.roleProfile) {
      check("tailor produced a resume + coverage + role profile", false, `phase=${tailor?.phase}`);
      return finish();
    }
    check("tailor reducer landed phase done", tailor.phase === "done", tailor.phase);
    check("coverage.mode is 'tailored' (selection succeeded)", tailor.coverage.mode === "tailored", tailor.coverage.mode);
    // The client re-runs the SAME pure gates the server used (the try-tailor precedent).
    verifyResolution(profile, tailor.resume, tailor.coverage, tailor.roleProfile);

    // 5) Toggles + diff: pure client-side re-folds, ZERO model/network calls.
    const firstEntry = tailor.resume.entries[0];
    const dropBullet = firstEntry?.bullets[0]?.bulletId;
    if (dropBullet) {
      const toggled = applyResumeToggles(
        tailor.resume,
        tailor.coverage,
        profile,
        { ...emptyToggles, excludedBulletIds: [dropBullet] },
      );
      check(
        "toggling a bullet off drops the coverage count by one (pure re-fold, no network)",
        toggled.coverage.bulletsSelected === tailor.coverage.bulletsSelected - 1,
        `${tailor.coverage.bulletsSelected} → ${toggled.coverage.bulletsSelected}`,
      );
    } else {
      check("resume has a bullet to toggle", false);
    }
    const diffBullet = firstEntry?.bullets[0]?.text;
    if (diffBullet) {
      // Identical input → all 'same' (no phantom changes on a verbatim bullet).
      const same = wordDiff(diffBullet, diffBullet);
      check("wordDiff of identical text is all 'same' spans", same.every((s) => s.kind === "same"));
      // A synthetic edit → real added + removed spans. The diff is model-
      // independent, so we exercise it with a driver-controlled pair rather than
      // depend on the model rephrasing (qwen3:4b returns all-verbatim — recorded).
      const edited = wordDiff("shipped the billing service monthly", "shipped the billing pipeline monthly");
      check(
        "wordDiff surfaces added + removed spans on an edited bullet",
        edited.some((s) => s.kind === "added") &&
          edited.some((s) => s.kind === "removed") &&
          edited.some((s) => s.kind === "same"),
      );
    }

    // 6) Render .tex through the real route (byte-equal to the domain generator).
    const tex = await renderTex(base, tailor.resume);
    if (tex) {
      check("server .tex byte-equals the local renderResumeTex", tex === renderResumeTex(tailor.resume));
      const anyBullet = tailor.resume.entries.flatMap((e) => e.bullets)[0]?.text;
      check(
        "a tailored bullet appears escaped in the .tex",
        anyBullet !== undefined && tex.includes(escapeLatexText(anyBullet)),
        anyBullet,
      );
    }

    // 7) Compile the PDF through the real route (Tectonic installed per README).
    await compilePdf(base, tailor.resume);

    console.log(`[${at()}] walkthrough complete in ${elapsedSeconds().toFixed(0)}s`);
  } finally {
    // Always remove the throwaway the walkthrough wrote (force: a no-op if save()
    // never ran); restore the real profile only when one existed — so a run on a
    // profile-less machine leaves it profile-less, not owning a stranger's resume.
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    if (hadProfile) renameSync(aside, PROFILE_DIR);
  }
  finish();
}

async function health(base: string): Promise<void> {
  const res = await fetch(`${base}/api/health`);
  const payload = (await res.json()) as {
    provider?: { id?: string; reachable?: boolean };
    tectonic?: { available?: boolean; version?: string; warmed?: boolean };
  };
  console.log(`[${at()}] /api/health provider=${payload.provider?.id} tectonic=${JSON.stringify(payload.tectonic)}`);
  check("keyless: resolved provider is ollama", payload.provider?.id === "ollama", payload.provider?.id);
  check("Ollama reachable at the configured base URL", payload.provider?.reachable === true);
  check(
    "Tectonic available (the health chip drives the PDF button)",
    payload.tectonic?.available === true,
    JSON.stringify(payload.tectonic),
  );
}

/** Drive an SSE route through the shared parser, feeding each frame to a
 *  reducer. Logs non-noise frame types; counts heartbeats. */
async function driveSse<S>(
  base: string,
  route: string,
  body: unknown,
  reduce: (state: S, action: { seq: number; event: PipelineEvent }) => S,
  initial: S,
  label: string,
): Promise<{ state: S; firstSeq?: number; firstType?: string; heartbeats: number } | null> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    check(`${label} route answered ok`, false, `HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    return null;
  }
  const parser = createSseParser();
  const reader = res.body.getReader();
  let state = initial;
  let firstSeq: number | undefined;
  let firstType: string | undefined;
  let heartbeats = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(value)) {
      const event = PipelineEventSchema.parse(JSON.parse(frame.data));
      const seq = Number(frame.id);
      firstSeq ??= seq;
      firstType ??= event.type;
      state = reduce(state, { seq, event });
      if (event.type === "heartbeat") {
        heartbeats += 1;
        continue;
      }
      if (event.type !== "synthesis.delta" && event.type !== "draft.delta") {
        console.log(`[${at()}] ${label} seq=${seq} ${event.type}`);
      }
    }
  }
  return { state, firstSeq, firstType, heartbeats };
}

async function drivePasteImport(base: string, text: string): Promise<ImportedEntries | undefined> {
  const out = await driveSse<ImportState>(
    base,
    "/api/profile/import/resume",
    { text },
    importReducer,
    importReducer(initialImportState, { type: "submit" }),
    "import",
  );
  if (!out) return undefined;
  check("import: first frame is profile.import.started at seq 0", out.firstSeq === 0 && out.firstType === "profile.import.started");
  check("import reducer landed phase done", out.state.phase === "done", `phase=${out.state.phase} err=${out.state.error ?? ""}`);
  if (elapsedSeconds() > 15) check("heartbeats rode the CPU extract", out.heartbeats > 0, `${out.heartbeats}`);
  return out.state.entries;
}

async function driveTailor(base: string, role: TailorRoleInput): Promise<TailorState | null> {
  const out = await driveSse<TailorState>(
    base,
    "/api/tailor",
    { role },
    tailorReducer,
    tailorReducer(initialTailorState, { type: "submit" }),
    "tailor",
  );
  if (!out) return null;
  check("tailor: first frame is tailor.started at seq 0", out.firstSeq === 0 && out.firstType === "tailor.started");
  return out.state;
}

async function driveGithubImport(base: string, username: string): Promise<ImportedEntries | undefined> {
  const reposRes = await fetch(`${base}/api/profile/import/github/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (reposRes.status !== 200) {
    check("GitHub stage A returned 200", false, `status=${reposRes.status} ${await reposRes.text().catch(() => "")}`);
    return undefined;
  }
  const listed = GithubReposResponseSchema.safeParse(await reposRes.json());
  if (!listed.success) {
    check("GitHub stage A response is zod-valid", false, listed.error.issues[0]?.message);
    return undefined;
  }
  console.log(
    `[${at()}] github listed ${listed.data.repos.length} repos order=${listed.data.order} rate=${listed.data.rate.remaining}/${listed.data.rate.limit}`,
  );
  const first = listed.data.repos[0];
  if (!first) {
    check(`GitHub user "${username}" has at least one public repo`, false);
    return undefined;
  }
  check("keyless order labeled honestly ('stars' — pins need a token)", listed.data.order === "stars", listed.data.order);
  const picked = [first.name];
  const importRes = await fetch(`${base}/api/profile/import/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, repos: picked }),
  });
  if (importRes.status !== 200) {
    check("GitHub stage B returned 200", false, `status=${importRes.status}`);
    return undefined;
  }
  const body = (await importRes.json()) as { entries: unknown };
  const parsed = ImportedEntriesSchema.safeParse(body.entries);
  if (!parsed.success) {
    check("GitHub stage B entries are zod-valid", false, parsed.error.issues[0]?.message);
    return undefined;
  }
  console.log(`[${at()}] github imported repo "${picked[0]}"`);
  return parsed.data;
}

async function save(base: string, profile: MasterProfile): Promise<void> {
  const res = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, overwrite: true }),
  });
  check("PUT /api/profile returned 200", res.status === 200, `status=${res.status}`);
}

async function roundTrip(base: string, expected: MasterProfile, when: string): Promise<MasterProfile> {
  const res = await fetch(`${base}/api/profile`);
  const body = (await res.json()) as { kind?: string; profile?: unknown };
  const same = body.kind === "ok" && JSON.stringify(body.profile) === JSON.stringify(expected);
  check(`GET /api/profile round-trips the saved profile byte-equal (${when})`, same, `kind=${body.kind}`);
  return MasterProfileSchema.parse(body.profile);
}

async function renderTex(base: string, resume: unknown): Promise<string | null> {
  const res = await fetch(`${base}/api/resume/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume, format: "tex" }),
  });
  check("render .tex returned 200 text/x-tex", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/x-tex"), `status=${res.status}`);
  if (res.status !== 200) return null;
  return res.text();
}

async function compilePdf(base: string, resume: unknown): Promise<void> {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/resume/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume, format: "pdf" }),
  });
  if (res.status !== 200) {
    check("compile PDF returned 200", false, `status=${res.status} ${await res.text().catch(() => "")}`);
    return;
  }
  check("compile PDF is application/pdf", (res.headers.get("content-type") ?? "").includes("application/pdf"));
  const bytes = new Uint8Array(await res.arrayBuffer());
  check("PDF bytes start %PDF-", new TextDecoder("latin1").decode(bytes.slice(0, 5)) === "%PDF-");
  const pages = pdfPageCount(bytes);
  check("pdfPageCount makes no false multi-page claim (0 = compressed objstm)", pages <= 1, String(pages));
  console.log(`[${at()}] compiled ${bytes.length}-byte PDF in ${Math.round(performance.now() - t0)}ms, pages=${pages}`);
}
