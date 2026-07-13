import { spawn } from "node:child_process";
import type { TectonicRunner } from "./TectonicCompiler";

// The real child-process seam for TectonicCompiler (pre-split under the
// 200-line ceiling; not in the PLAN-RESUME.md §2 tree). Tests inject their own
// TectonicRunner (the pingOllama injected-runner precedent); production spawns
// the resolved ABSOLUTE binary path directly — never through a shell — so
// Windows won't fail to resolve a `.exe` shim, and `windowsHide` keeps no
// console window flashing. stdout/stderr capture is capped; a timeout or an
// outer-signal abort kills the child (SIGTERM, then SIGKILL after a grace).

const CAPTURE_CAP = 512 * 1024; // bounded capture — diagnostics are short
const HARD_KILL_GRACE_MS = 2_000;

export const spawnRunner: TectonicRunner = (spec) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(spec.binPath, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };

    const kill = () => {
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), HARD_KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);

    const onAbort = () => kill();
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    // An ALREADY-aborted signal never fires the event, so kill immediately —
    // otherwise a request cancelled during the pre-spawn awaits (probe,
    // mkdtemp) would orphan a network-active child for the whole timeout.
    if (spec.signal?.aborted) kill();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < CAPTURE_CAP) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < CAPTURE_CAP) stderr += chunk.toString();
    });
    // spawn errors (ENOENT, EACCES) arrive here, never as a close code.
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
