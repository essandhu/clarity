import { describe, expect, it } from "vitest";
import { spawnRunner } from "./tectonicRunner";

// The real child-process seam — the sole enforcement of the compile ceiling
// (decision 15's runaway-process guarantee) and the abort path. Exercised
// against short-lived `node` children (process.execPath is always present, no
// PATH dependency) so the timeout kill, capture, and abort logic are pinned —
// the compiler tests only inject a FAKE runner.

const NODE = process.execPath;

describe("spawnRunner", () => {
  it("captures stdout/stderr and the exit code of a normal run", async () => {
    const res = await spawnRunner({
      binPath: NODE,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      timeoutMs: 5_000,
    });
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.timedOut).toBe(false);
  });

  it("kills a hung child on timeout and reports timedOut", async () => {
    const res = await spawnRunner({
      binPath: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"], // never exits on its own
      timeoutMs: 150,
    });
    expect(res.timedOut).toBe(true); // resolving at all proves the child was killed
  });

  it("kills the child when the outer signal aborts mid-run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const res = await spawnRunner({
      binPath: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30_000, // must NOT wait for this — the abort kills it
      signal: controller.signal,
    });
    expect(res.timedOut).toBe(false); // aborted, not timed out
  });

  it("kills immediately when the signal is ALREADY aborted at spawn time", async () => {
    // The regression pin: an already-aborted signal never fires 'abort', so
    // without the pre-spawn short-circuit this would hang until the 30s timeout
    // (and time the test out) rather than resolving promptly.
    const res = await spawnRunner({
      binPath: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30_000,
      signal: AbortSignal.abort(),
    });
    expect(res.timedOut).toBe(false);
  });

  it("resolves code null when the binary cannot be spawned", async () => {
    const res = await spawnRunner({
      binPath: "C:/no/such/binary-xyz",
      args: ["--version"],
      timeoutMs: 2_000,
    });
    expect(res.code).toBeNull();
  });
});
