// Live proofs for the tailor pipeline, one mode per §7.13 verification item
// (the try-cache.ts precedent: the REAL parseSse + tailorReducer drive the
// live wire, frames timestamped, the pure gates re-run client-side):
//
//   cd apps/web && npx tsx scripts/try-tailor.ts --role fixtures/listings/sparse-startup.txt [--record]
//   cd apps/web && npx tsx scripts/try-tailor.ts --role fixtures/resume/hostile-role.txt --hostile
//   cd apps/web && npx tsx scripts/try-tailor.ts --profile-path [--abort]
//   cd apps/web && npx tsx scripts/try-tailor.ts --role <file> --abort
//   cd apps/web && npx tsx scripts/try-tailor.ts --empty
//   cd apps/web && npx tsx scripts/try-tailor.ts --render-tex   (increment 14)
//
// Exits 0 only if every in-driver assertion passes; prints a JSON summary last.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSseParser } from "../src/components/parseSse";
import {
  initialTailorState,
  tailorReducer,
  type TailorState,
} from "../src/components/resume/useTailorRun";
import { escapeLatexText } from "../src/domain/resume/latexEscape";
import { renderResumeTex } from "../src/domain/resume/resumeLatex";
import {
  MasterProfileSchema,
  PipelineEventSchema,
  TailoredResumeSchema,
  type ListingProfile,
  type MasterProfile,
  type PipelineEvent,
  type TailorRoleInput,
} from "../src/shared/schema";
import { at, check, elapsedSeconds, finish } from "./importProofs/harness";
import { verifyHostileSurface, verifyResolution } from "./tailorProofs/verify";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rolePath = value("--role");
const base = value("--base") ?? "http://localhost:3000";
const hostileMode = flag("--hostile");
const profilePathMode = flag("--profile-path");
const abortMode = flag("--abort");
const emptyMode = flag("--empty");
const recordMode = flag("--record");
const renderTexMode = flag("--render-tex");

const MASTER_FIXTURE = "fixtures/resume/master-profile.json";
const RECORD_PATH = "fixtures/event-streams/tailor-run.jsonl";
const PROFILE_FILE = path.join("data", "profile", "master.json");

async function main(): Promise<void> {
  if (emptyMode) {
    await proveEmpty409();
    finish();
    return;
  }
  if (renderTexMode) {
    await proveRenderTex();
    finish();
    return;
  }
  if (!profilePathMode && !rolePath) {
    console.error(
      "usage: npx tsx scripts/try-tailor.ts (--role <file> [--hostile] [--record] | --profile-path | --empty) [--abort] [--base url]",
    );
    process.exit(1);
  }

  const master = await putPinnedProfile();
  const role = buildRole();
  const outcome = await driveTailor(role);
  if (!outcome) {
    finish();
    return;
  }
  const { state, frames, heartbeats, framesAfterAbort } = outcome;

  const first = frames[0];
  check(
    "first frame is tailor.started at seq 0",
    first?.seq === 0 && first.event.type === "tailor.started",
    JSON.stringify(first),
  );

  if (abortMode) {
    check("no terminal frame reached the reducer (idle after abort)", state.phase === "idle", `phase=${state.phase}`);
    check("zero frames after the abort", framesAfterAbort === 0, String(framesAfterAbort));
    check("no resume retained", state.resume === undefined);
    finish();
    return;
  }

  check("reducer landed phase done", state.phase === "done", `phase=${state.phase} err=${JSON.stringify(state.error ?? null)}`);
  if (elapsedSeconds() > 15) {
    check("heartbeats rode the CPU model call(s)", heartbeats > 0, `${heartbeats} heartbeats`);
  }

  const roleSteps = frames.filter(
    (f) => f.event.type === "step.started" && f.event.stepId === "tailor-role-extract",
  );
  if (role.kind === "text") {
    check("text path: role-extraction step + tailor.role.completed precede selection", roleSteps.length === 1 && state.roleProfile !== undefined);
    check(
      "selection step label is byte-exact",
      frames.some(
        (f) =>
          f.event.type === "step.started" &&
          f.event.stepId === "tailor-select" &&
          f.event.label === "Selecting from your master profile…",
      ),
    );
  } else {
    check("profile path: NO extraction step appears in the stream", roleSteps.length === 0);
    check("profile path: no tailor.role.completed frame", !frames.some((f) => f.event.type === "tailor.role.completed"));
  }

  if (!state.resume || !state.coverage) {
    check("resume + coverage present on the terminal frame", false);
    finish();
    return;
  }
  const roleProfile = role.kind === "profile" ? role.profile : state.roleProfile;
  if (!roleProfile) {
    check("role profile available for gate re-runs", false);
    finish();
    return;
  }
  verifyResolution(master, state.resume, state.coverage, roleProfile);
  check("coverage.mode on the live run", state.coverage.mode === "tailored", state.coverage.mode);
  if (hostileMode) verifyHostileSurface(state.resume, state.coverage);

  if (recordMode) {
    writeFileSync(
      RECORD_PATH,
      `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`,
      "utf8",
    );
    console.log(`[${at()}] recorded ${frames.length} frames -> ${RECORD_PATH}`);
  }
  finish();
}

/** §7.13: every live proof runs against the pinned, version-controlled,
 *  deliberately kubernetes-free profile. */
async function putPinnedProfile(): Promise<MasterProfile> {
  const raw = readFileSync(MASTER_FIXTURE, "utf8");
  check("pinned master fixture is kubernetes-free", !raw.toLowerCase().includes("kubernetes"));
  const master = MasterProfileSchema.parse(JSON.parse(raw));
  const res = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: master, overwrite: true }),
  });
  check("PUT /api/profile (pinned fixture) returned 200", res.status === 200, `status=${res.status}`);
  return master;
}

function buildRole(): TailorRoleInput {
  if (!profilePathMode) {
    return { kind: "text", text: readFileSync(rolePath!, "utf8") };
  }
  // The handoff shape: a ListingProfile posted verbatim (decision 54's wire
  // half) — built from the same sparse fixture the analyze proofs use.
  const rawText = readFileSync("fixtures/listings/sparse-startup.txt", "utf8");
  const profile: ListingProfile = {
    company: "Driftlock",
    role: "Backend Engineer",
    namedTechnologies: [],
    productArea: "software that helps small warehouse operators catch inventory drift",
    rawText,
  };
  return { kind: "profile", profile };
}

interface DriveOutcome {
  state: TailorState;
  frames: { seq: number; event: PipelineEvent }[];
  heartbeats: number;
  framesAfterAbort: number;
}

async function driveTailor(role: TailorRoleInput): Promise<DriveOutcome | null> {
  let state = tailorReducer(initialTailorState, { type: "submit" });
  const frames: { seq: number; event: PipelineEvent }[] = [];
  let heartbeats = 0;
  let framesAfterAbort = 0;
  let aborted = false;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;

  const controller = new AbortController();
  const res = await fetch(`${base}/api/tailor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
    return null;
  }

  const parser = createSseParser();
  const reader = res.body.getReader();
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
        frames.push({ seq, event });
        state = tailorReducer(state, { seq, event });
        if (event.type === "heartbeat") {
          heartbeats += 1;
          continue;
        }
        console.log(
          `[${at()}] seq=${seq} ${event.type}${
            event.type === "step.started"
              ? ` ${event.stepId}`
              : event.type === "step.finished"
                ? ` ${event.stepId} ${event.status}${event.skip ? ` (${event.skip.reason})` : ""}`
                : event.type === "tailor.completed"
                  ? ` entries=${event.resume.entries.length} mode=${event.coverage.mode} rephrased=${event.coverage.bulletsRephrased} reverted=${event.coverage.bulletsReverted}`
                  : ""
          }`,
        );
        if (
          abortMode &&
          event.type === "step.started" &&
          event.stepId === "tailor-select" &&
          abortTimer === undefined
        ) {
          // Mid-SELECTION teardown (§7.13): the CPU selection runs minutes;
          // 2s into it the model is guaranteed to still be generating.
          abortTimer = setTimeout(() => {
            console.log(`[${at()}] aborting client-side (mid-selection)`);
            aborted = true;
            state = tailorReducer(state, { type: "aborted" });
            controller.abort();
          }, 2_000);
        }
      }
    }
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
  }
  return { state, frames, heartbeats, framesAfterAbort };
}

/** The full pre-stream preflight (§3 + review F11): empty ⇒ 409
 *  PROFILE_MISSING with steering copy; unreadable ⇒ 409 PROFILE_UNREADABLE
 *  naming the .bak; non-JSON and invalid-shape bodies ⇒ typed 400s. The
 *  driver moves/corrupts the stored profile and restores the ORIGINAL bytes
 *  in finally (the .bak untouched throughout). */
async function proveEmpty409(): Promise<void> {
  const validRole = {
    role: { kind: "text", text: "A role paste long enough to clear the 40-character floor." },
  };
  const post = (body: string) =>
    fetch(`${base}/api/tailor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  const aside = `${PROFILE_FILE}.tailor-409-aside`;
  const existed = existsSync(PROFILE_FILE);
  if (existed) renameSync(PROFILE_FILE, aside);
  try {
    const res = await post(JSON.stringify(validRole));
    const body = (await res.json()) as { code?: string; message?: string };
    check("empty profile ⇒ HTTP 409, stream never opened", res.status === 409, `status=${res.status}`);
    check("code PROFILE_MISSING", body.code === "PROFILE_MISSING", body.code);
    check(
      "steering copy names the Master profile panel",
      typeof body.message === "string" && body.message.includes("Master profile"),
      body.message,
    );

    // Unreadable: a corrupt master.json (never the user's real one — the
    // original is aside and restored below).
    writeFileSync(PROFILE_FILE, "this is { not json", "utf8");
    const unreadable = await post(JSON.stringify(validRole));
    const unreadableBody = (await unreadable.json()) as { code?: string; message?: string };
    check("unreadable profile ⇒ HTTP 409", unreadable.status === 409, `status=${unreadable.status}`);
    check("code PROFILE_UNREADABLE", unreadableBody.code === "PROFILE_UNREADABLE", unreadableBody.code);
    check(
      "unreadable copy names the .bak restore path",
      typeof unreadableBody.message === "string" && unreadableBody.message.includes("master.json.bak"),
      unreadableBody.message,
    );

    const notJson = await post("this is not json");
    check("non-JSON body ⇒ typed 400", notJson.status === 400, `status=${notJson.status}`);
    const badShape = await post(JSON.stringify({ role: { kind: "text", text: "short" } }));
    const badShapeBody = (await badShape.json()) as { code?: string };
    check(
      "invalid role shape ⇒ typed 400 INPUT_INVALID",
      badShape.status === 400 && badShapeBody.code === "INPUT_INVALID",
      `status=${badShape.status} code=${badShapeBody.code}`,
    );
  } finally {
    if (existsSync(PROFILE_FILE)) rmSync(PROFILE_FILE); // the corrupt stand-in
    if (existed) renameSync(aside, PROFILE_FILE);
  }
}

/** §7.14: increment-13's saved live TailoredResume, rendered through the REAL
 *  /api/resume/render route. Proves the route regenerates the .tex from the
 *  domain (byte-equal to renderResumeTex), every master bullet survives
 *  escaped, a planted \input is inert, a smuggled raw `tex` field is a 400,
 *  and pdf honestly 501s until Tectonic lands (increment 15). */
async function proveRenderTex(): Promise<void> {
  const recorded = readFileSync(RECORD_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: PipelineEvent });
  const completed = recorded.find((f) => f.event.type === "tailor.completed");
  check("tailor-run.jsonl carries a tailor.completed frame", completed !== undefined);
  if (completed?.event.type !== "tailor.completed") {
    finish();
    return;
  }
  const resume = TailoredResumeSchema.parse(completed.event.resume);
  const originalBullets = resume.entries.flatMap((entry) => entry.bullets.map((b) => b.text));
  check("saved resume has bullets to verify", originalBullets.length > 0);

  // Plant a \input injection into the first bullet (the rest stay master text).
  const hostile = structuredClone(resume);
  const target = hostile.entries[0]?.bullets[0];
  if (!target) {
    check("saved resume has a bullet to plant into", false);
    finish();
    return;
  }
  target.text = "\\input{/etc/passwd} then genuine work";
  // Plant a hostile-but-HttpUrl-valid URL into an identity link (review HIGH:
  // the URL slots were the only fields never given a payload). Braces would
  // break the \href group; ^^/& synthesize control sequences / alignment tabs.
  if (hostile.identity.links[0]) {
    hostile.identity.links[0].url = "https://ex.com/}{\\input{/etc/passwd}}?x=1&y=2^^5c";
  }

  const post = (payload: unknown) =>
    fetch(`${base}/api/resume/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const res = await post({ resume: hostile, format: "tex" });
  check("render tex ⇒ 200", res.status === 200, `status=${res.status}`);
  check(
    "content-type is text/x-tex",
    (res.headers.get("content-type") ?? "").includes("text/x-tex"),
    res.headers.get("content-type") ?? "",
  );
  check(
    "attachment filename is resume-<slug>.tex",
    /attachment; filename="resume-[a-z0-9-]+\.tex"/.test(res.headers.get("content-disposition") ?? ""),
    res.headers.get("content-disposition") ?? "",
  );
  const tex = await res.text();
  console.log(`[${at()}] rendered ${tex.length} bytes of .tex`);

  // The route regenerates from the domain — byte-equal, no drift (decision 49).
  check("server .tex byte-equals the local renderResumeTex", tex === renderResumeTex(hostile));

  const body = tex.split("\\begin{document}")[1] ?? "";
  // Every remaining master bullet appears escaped (the first was replaced).
  for (const bullet of originalBullets.slice(1)) {
    check(
      `master bullet appears escaped: "${bullet.slice(0, 40)}…"`,
      body.includes(escapeLatexText(bullet)),
      bullet,
    );
  }
  // The injection is inert: escaped present, raw control sequence absent.
  check(
    "planted \\input rendered as \\textbackslash{}input\\{…\\}",
    body.includes("\\textbackslash{}input\\{/etc/passwd\\}"),
  );
  check("no raw \\input{ in the document body", !body.includes("\\input{"));
  // Every \href target (mailto + the hostile link URL) is free of raw group /
  // control / alignment-tab characters (review HIGH — the URL choke point).
  const hrefTargets = [...tex.matchAll(/\\href\{([^{}]*)\}\{/g)].map((m) => m[1]);
  check("at least mailto + link \\href targets present", hrefTargets.length >= 2, String(hrefTargets.length));
  const badTarget = hrefTargets.find(
    (t) => t.replace(/\\[%#]/g, "").includes("\\") || t.includes("^^") || /(?<!\\)&/.test(t),
  );
  check("no \\href target carries a raw backslash / ^^ / & (URL escaping wired)", badTarget === undefined, badTarget ?? "");
  check("brace-break URL was percent-encoded (no raw group break)", !body.includes("https://ex.com/}"), "");

  // Negative: a body smuggling a raw `tex` field is a 400 (decision 49).
  const smuggle = await post({ resume, format: "tex", tex: "\\immediate\\write18{rm -rf /}" });
  check("raw `tex` field ⇒ 400", smuggle.status === 400, `status=${smuggle.status}`);

  // pdf honestly 501s until Tectonic lands (increment 15).
  const pdf = await post({ resume, format: "pdf" });
  check("format:pdf ⇒ 501 (Tectonic lands in increment 15)", pdf.status === 501, `status=${pdf.status}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
