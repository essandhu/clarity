// Live proofs for the profile importers, one mode per §7 verification list
// (11: paste; 12: github + linkedin — those two live in scripts/importProofs/,
// a pre-split under the script-size convention):
//
//   cd apps/web && npx tsx scripts/try-import.ts --paste fixtures/resume/pasted-resume.txt [base-url]
//   cd apps/web && npx tsx scripts/try-import.ts --paste <file> --abort   # mid-import teardown proof
//   cd apps/web && npx tsx scripts/try-import.ts --github <username> [base-url]
//   cd apps/web && npx tsx scripts/try-import.ts --linkedin [base-url]
//
// Exits 0 only if every in-driver assertion passes; prints a JSON summary last.
import { readFileSync } from "node:fs";
import { createSseParser } from "../src/components/parseSse";
import {
  importReducer,
  initialImportState,
  type ImportState,
} from "../src/components/resume/useResumeImportRun";
import { mergeImportedEntries } from "../src/domain/profile/profileMerge";
import {
  dateTokensAppear,
  IMPORT_FALLBACK_CATEGORY,
  normalizeForMatch,
} from "../src/domain/profile/resumeImportGrounding";
import {
  emptyMasterProfile,
  MasterProfileSchema,
  PipelineEventSchema,
  type ImportedEntries,
} from "../src/shared/schema";
import { runGithubProof } from "./importProofs/github";
import { at, check, elapsedSeconds, finish } from "./importProofs/harness";
import { runLinkedinProof } from "./importProofs/linkedin";

const argv = process.argv.slice(2);
const abortMode = argv.includes("--abort");
const pasteIdx = argv.indexOf("--paste");
const githubIdx = argv.indexOf("--github");
const linkedinMode = argv.includes("--linkedin");
const pastePath = pasteIdx >= 0 ? argv[pasteIdx + 1] : undefined;
const githubUser = githubIdx >= 0 ? argv[githubIdx + 1] : undefined;
const base =
  argv.filter((a, i) => !a.startsWith("--") && i !== pasteIdx + 1 && i !== githubIdx + 1)[0] ??
  "http://localhost:3000";

if (githubUser !== undefined) {
  runGithubProof(githubUser, base).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
} else if (linkedinMode) {
  runLinkedinProof(base).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
} else if (!pastePath) {
  console.error(
    "usage: npx tsx scripts/try-import.ts (--paste <file> [--abort] | --github <username> | --linkedin) [base-url]",
  );
  process.exit(1);
}
const pasted = pastePath !== undefined ? readFileSync(pastePath, "utf8") : "";

async function main(): Promise<void> {
  let state: ImportState = importReducer(initialImportState, { type: "submit" });
  let firstFrame: { seq: number; type: string } | undefined;
  let heartbeats = 0;
  let framesAfterAbort = 0;
  let aborted = false;

  const controller = new AbortController();
  const res = await fetch(`${base}/api/profile/import/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: pasted }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const parser = createSseParser();
  const reader = res.body.getReader();
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (aborted) break; // deliberate teardown
        throw err;
      }
      if (chunk.done) break;
      for (const frame of parser.push(chunk.value)) {
        const event = PipelineEventSchema.parse(JSON.parse(frame.data));
        const seq = Number(frame.id);
        if (aborted) {
          framesAfterAbort += 1;
          continue;
        }
        state = importReducer(state, { seq, event });
        if (!firstFrame) firstFrame = { seq, type: event.type };
        if (event.type === "heartbeat") {
          heartbeats += 1;
          continue;
        }
        console.log(
          `[${at()}] seq=${seq} ${event.type}${
            event.type === "profile.import.completed"
              ? ` entries=${countEntries(event.entries)} dropped=${event.report.droppedStrings.length} truncated=${event.report.truncated}`
              : ""
          }`,
        );
        if (abortMode && event.type === "profile.import.started") {
          // Tear down mid-extraction: the CPU extract runs minutes; 3s in it
          // is guaranteed to still be generating.
          abortTimer = setTimeout(() => {
            console.log(`[${at()}] aborting client-side (mid-extraction)`);
            aborted = true;
            state = importReducer(state, { type: "aborted" });
            controller.abort();
          }, 3_000);
        }
      }
    }
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
  }

  check("first frame is profile.import.started at seq 0", firstFrame?.seq === 0 && firstFrame.type === "profile.import.started", JSON.stringify(firstFrame));

  if (abortMode) {
    check("no terminal frame reached the reducer", state.phase === "idle", `phase=${state.phase}`);
    check("zero frames after the abort", framesAfterAbort === 0, String(framesAfterAbort));
    check("no entries retained", state.entries === undefined);
    finish();
    return;
  }

  check("reducer landed phase done", state.phase === "done", `phase=${state.phase} err=${state.error ?? ""}`);
  const runSeconds = elapsedSeconds();
  if (runSeconds > 15) {
    check("heartbeats rode the long extract", heartbeats > 0, `${heartbeats} heartbeats over ${runSeconds.toFixed(0)}s`);
  }

  const entries = state.entries;
  if (!entries) {
    check("entries present on the terminal frame", false);
    finish();
    return;
  }
  verifyVerbatim(entries);
  await roundTrip(entries);
  finish();
}

/** The client-side re-run of the §4.5 gate: EVERY string field of every
 *  imported entry must be a normalized substring of the paste; dates obey
 *  the digit-run + alpha-token rule. */
function verifyVerbatim(entries: ImportedEntries): void {
  const haystack = normalizeForMatch(pasted);
  const failures: string[] = [];
  const need = (path: string, value: string | undefined) => {
    if (value !== undefined && !haystack.includes(normalizeForMatch(value))) {
      failures.push(`${path}: "${value.slice(0, 60)}"`);
    }
  };
  const needDate = (path: string, value: string | undefined) => {
    if (value !== undefined && !dateTokensAppear(value, haystack)) {
      failures.push(`${path}: "${value}"`);
    }
  };
  entries.experience.forEach((e, i) => {
    need(`experience[${i}].org`, e.org);
    need(`experience[${i}].role`, e.role);
    need(`experience[${i}].location`, e.location);
    needDate(`experience[${i}].startDate`, e.startDate);
    needDate(`experience[${i}].endDate`, e.endDate);
    e.bullets.forEach((b, bi) => need(`experience[${i}].bullets[${bi}]`, b.text));
  });
  entries.projects.forEach((p, i) => {
    need(`projects[${i}].name`, p.name);
    p.technologies.forEach((t, ti) => need(`projects[${i}].technologies[${ti}]`, t));
    needDate(`projects[${i}].startDate`, p.startDate);
    needDate(`projects[${i}].endDate`, p.endDate);
    p.bullets.forEach((b, bi) => need(`projects[${i}].bullets[${bi}]`, b.text));
  });
  entries.education.forEach((e, i) => {
    need(`education[${i}].school`, e.school);
    need(`education[${i}].degree`, e.degree);
    need(`education[${i}].location`, e.location);
    need(`education[${i}].notes`, e.notes);
    needDate(`education[${i}].startDate`, e.startDate);
    needDate(`education[${i}].endDate`, e.endDate);
  });
  entries.skills.forEach((g, i) => {
    if (g.category !== IMPORT_FALLBACK_CATEGORY) need(`skills[${i}].category`, g.category);
    g.items.forEach((item, ii) => need(`skills[${i}].items[${ii}]`, item));
  });
  const provenanceOk =
    [...entries.experience, ...entries.projects, ...entries.education].every(
      (e) => e.provenance.origin === "pasted-resume",
    );
  check("EVERY imported string is verbatim-grounded in the paste (dates incl.)", failures.length === 0, failures.slice(0, 5).join("; ") || undefined);
  check("every entry carries pasted-resume provenance", provenanceOk);
}

/** PUT the merged profile, GET it back byte-equal (the store round-trip). */
async function roundTrip(entries: ImportedEntries): Promise<void> {
  const blank = emptyMasterProfile("Maya Chen", new Date().toISOString());
  const { profile } = mergeImportedEntries(blank, entries, new Date().toISOString());
  const parsed = MasterProfileSchema.safeParse(profile);
  check("merged profile is zod-valid", parsed.success, parsed.success ? undefined : parsed.error.issues[0]?.message);
  if (!parsed.success) return;

  const put = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  check("PUT /api/profile returned 200", put.status === 200, `status=${put.status}`);

  const get = await fetch(`${base}/api/profile`);
  const body = (await get.json()) as { kind?: string; profile?: unknown };
  check(
    "GET /api/profile round-trips the saved profile byte-equal",
    body.kind === "ok" && JSON.stringify(body.profile) === JSON.stringify(profile),
    `kind=${body.kind}`,
  );
}

function countEntries(entries: ImportedEntries): number {
  return (
    entries.experience.length +
    entries.projects.length +
    entries.education.length +
    entries.skills.length
  );
}

if (pastePath !== undefined) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
