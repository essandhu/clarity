import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunResult,
  type RunSpec,
  type TectonicRunner,
  TectonicCompiler,
} from "./TectonicCompiler";

// Injected-runner fakes (the pingOllama seam): the child process is the ONE
// mocked edge — everything else (mkdtemp, tex write, pdf read, warmed marker)
// is real fs against a per-test temp dir, and the fake "tectonic" simulates the
// engine by writing resume.pdf into the outdir. fileExists is faked so the
// synthetic binary path resolves without touching a real filesystem entry.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clarity-tec-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RunnerHandle {
  runner: TectonicRunner;
  specs: RunSpec[];
  compileSpecs: RunSpec[];
}

function makeRunner(behavior: {
  versionStdout?: string;
  versionCode?: number;
  versionTimedOut?: boolean;
  onCompile?: (spec: RunSpec) => Promise<RunResult> | RunResult;
}): RunnerHandle {
  const specs: RunSpec[] = [];
  const runner: TectonicRunner = async (spec) => {
    specs.push(spec);
    if (spec.args.includes("--version")) {
      return {
        code: behavior.versionCode ?? 0,
        stdout: behavior.versionStdout ?? "Tectonic 0.16.9\n",
        stderr: "",
        timedOut: behavior.versionTimedOut ?? false,
      };
    }
    if (!behavior.onCompile) throw new Error("unexpected compile spawn");
    return behavior.onCompile(spec);
  };
  return {
    runner,
    specs,
    get compileSpecs() {
      return specs.filter((s) => !s.args.includes("--version"));
    },
  };
}

const okCompile = async (spec: RunSpec): Promise<RunResult> => {
  await writeFile(path.join(spec.cwd!, "resume.pdf"), "%PDF-1.5\nfake\n%%EOF\n");
  return { code: 0, stdout: "", stderr: "", timedOut: false };
};

function compilerAt(warmedPath: string, runner: TectonicRunner) {
  return new TectonicCompiler({
    tectonicPath: "tectonic", // synthetic — resolved by the fake fileExists
    warmedPath,
    runner,
    fileExists: async () => true,
    env: {}, // empty base so TECTONIC_UNTRUSTED_MODE is the only entry we add
  });
}

async function markWarmed(warmedPath: string): Promise<void> {
  await writeFile(warmedPath, JSON.stringify({ warmedAt: "2026-07-13T00:00:00.000Z" }));
}

describe("TectonicCompiler — probe", () => {
  it("parses the version and reports availability + warmed state", async () => {
    const warmedPath = path.join(dir, "warmed.json");
    await markWarmed(warmedPath);
    const handle = makeRunner({ versionStdout: "Tectonic 0.16.9\n" });
    const probe = await compilerAt(warmedPath, handle.runner).probe();
    expect(probe).toEqual({ available: true, version: "0.16.9", warmed: true });
  });

  it("reports unavailable when the binary cannot be resolved", async () => {
    const handle = makeRunner({});
    const compiler = new TectonicCompiler({
      tectonicPath: "C:/nowhere/tectonic.exe",
      warmedPath: path.join(dir, "warmed.json"),
      runner: handle.runner,
      fileExists: async () => false,
    });
    expect(await compiler.probe()).toEqual({ available: false, warmed: false });
    // A missing binary never spawns --version.
    expect(handle.specs).toHaveLength(0);
  });

  it("reports unavailable when --version times out or errors", async () => {
    const timedOut = makeRunner({ versionTimedOut: true });
    expect(await compilerAt(path.join(dir, "w.json"), timedOut.runner).probe()).toMatchObject({
      available: false,
    });
    const errored = makeRunner({ versionCode: 1, versionStdout: "" });
    expect(await compilerAt(path.join(dir, "w2.json"), errored.runner).probe()).toMatchObject({
      available: false,
    });
  });
});

describe("TectonicCompiler — compile success", () => {
  it("cold compile omits --only-cached, succeeds, and writes the warmed marker", async () => {
    const warmedPath = path.join(dir, "warmed.json");
    const handle = makeRunner({ onCompile: okCompile });
    const compiler = compilerAt(warmedPath, handle.runner);

    const result = await compiler.compile("\\documentclass{article}", { timeoutMs: 600_000 });
    expect(result.kind).toBe("pdf");
    if (result.kind === "pdf") {
      expect(Buffer.from(result.bytes).toString("utf8").startsWith("%PDF-")).toBe(true);
    }
    const spec = handle.compileSpecs[0]!;
    expect(spec.args).toEqual(["-X", "compile", "resume.tex", "--outdir", spec.cwd, "--untrusted"]);
    expect(spec.args).not.toContain("--only-cached");
    expect(spec.env?.TECTONIC_UNTRUSTED_MODE).toBe("1");
    // The first success turns the marker on.
    await expect(stat(warmedPath)).resolves.toBeDefined();
  });

  it("a warmed compile adds --only-cached", async () => {
    const warmedPath = path.join(dir, "warmed.json");
    await markWarmed(warmedPath);
    const handle = makeRunner({ onCompile: okCompile });
    await compilerAt(warmedPath, handle.runner).compile("tex", { timeoutMs: 180_000 });
    expect(handle.compileSpecs[0]!.args).toContain("--only-cached");
  });

  it("allowBundleDownload re-opens the network even when warmed (no --only-cached)", async () => {
    const warmedPath = path.join(dir, "warmed.json");
    await markWarmed(warmedPath);
    const handle = makeRunner({ onCompile: okCompile });
    await compilerAt(warmedPath, handle.runner).compile("tex", {
      timeoutMs: 600_000,
      allowBundleDownload: true,
    });
    expect(handle.compileSpecs[0]!.args).not.toContain("--only-cached");
  });

  it("cleans up its temp dir after a successful compile", async () => {
    const handle = makeRunner({ onCompile: okCompile });
    let capturedCwd = "";
    const wrapped: TectonicRunner = async (spec) => {
      if (!spec.args.includes("--version")) capturedCwd = spec.cwd!;
      return handle.runner(spec);
    };
    await compilerAt(path.join(dir, "w.json"), wrapped).compile("tex", { timeoutMs: 1_000 });
    await expect(stat(capturedCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("TectonicCompiler — failure taxonomy", () => {
  it("a timeout is reason:timeout, not a crash", async () => {
    const handle = makeRunner({
      onCompile: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    const result = await compilerAt(path.join(dir, "w.json"), handle.runner).compile("tex", {
      timeoutMs: 10,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  it("exit 1 parses `error:` diagnostics and filters the Fontconfig noise line", async () => {
    const stderr = [
      "Fontconfig error: Cannot load default config file: No such file: (null)",
      "error: resume.tex:3: Undefined control sequence \\foo.",
      "note: some non-error chatter",
    ].join("\n");
    const handle = makeRunner({
      onCompile: async () => ({ code: 1, stdout: "", stderr, timedOut: false }),
    });
    const result = await compilerAt(path.join(dir, "w.json"), handle.runner).compile("tex", {
      timeoutMs: 180_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "latex_error" });
    if (result.kind === "failed") {
      expect(result.diagnostics).toEqual(["error: resume.tex:3: Undefined control sequence \\foo."]);
      expect(result.diagnostics.join("\n")).not.toMatch(/fontconfig/i);
    }
  });

  it("a crash-shaped exit with a STALE pdf is reason:crashed, never a stale success", async () => {
    const handle = makeRunner({
      onCompile: async (spec) => {
        // A prior run's output is present, but the process crashed (0xC0000409).
        await writeFile(path.join(spec.cwd!, "resume.pdf"), "%PDF-stale\n");
        return { code: 3221226505, stdout: "", stderr: "", timedOut: false };
      },
    });
    const result = await compilerAt(path.join(dir, "w.json"), handle.runner).compile("tex", {
      timeoutMs: 180_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "crashed" });
  });

  it("exit 0 with no pdf is reason:crashed", async () => {
    const handle = makeRunner({
      onCompile: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    });
    const result = await compilerAt(path.join(dir, "w.json"), handle.runner).compile("tex", {
      timeoutMs: 180_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "crashed" });
  });

  it("an --only-cached miss is cache_missing_offline and NEVER retries with network", async () => {
    const warmedPath = path.join(dir, "warmed.json");
    await markWarmed(warmedPath);
    const handle = makeRunner({
      // Under --only-cached a missing package fails like a normal error (exit 1,
      // no pdf) — but the template is always valid, so it can only be the bundle.
      onCompile: async () => ({
        code: 1,
        stdout: "",
        stderr: "error: unable to open cached bundle; try without --only-cached",
        timedOut: false,
      }),
    });
    const result = await compilerAt(warmedPath, handle.runner).compile("tex", { timeoutMs: 180_000 });
    expect(result).toMatchObject({ kind: "failed", reason: "cache_missing_offline" });
    // The runner log proves exactly ONE compile spawn — no silent network-open retry.
    expect(handle.compileSpecs).toHaveLength(1);
    expect(handle.compileSpecs[0]!.args).toContain("--only-cached");
  });

  it("an oversized pdf is reason:output_too_large", async () => {
    const handle = makeRunner({
      onCompile: async (spec) => {
        await writeFile(path.join(spec.cwd!, "resume.pdf"), Buffer.alloc(10 * 1024 * 1024 + 1, 0x25));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const result = await compilerAt(path.join(dir, "w.json"), handle.runner).compile("tex", {
      timeoutMs: 180_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "output_too_large" });
  });

  it("returns unavailable (not a crash) when the binary vanishes at compile time", async () => {
    const handle = makeRunner({ onCompile: okCompile });
    const compiler = new TectonicCompiler({
      tectonicPath: "tectonic",
      warmedPath: path.join(dir, "w.json"),
      runner: handle.runner,
      fileExists: async () => false,
    });
    expect(await compiler.compile("tex", { timeoutMs: 1_000 })).toEqual({ kind: "unavailable" });
    expect(handle.compileSpecs).toHaveLength(0);
  });
});

describe("TectonicCompiler — server-regenerated source only", () => {
  it("writes exactly the passed .tex into the compile dir", async () => {
    let written = "";
    const handle = makeRunner({
      onCompile: async (spec) => {
        written = await readFile(path.join(spec.cwd!, "resume.tex"), "utf8");
        return okCompile(spec);
      },
    });
    await compilerAt(path.join(dir, "w.json"), handle.runner).compile("\\safe{content}", {
      timeoutMs: 1_000,
    });
    expect(written).toBe("\\safe{content}");
  });
});

describe("TectonicCompiler — PATH scan (no TECTONIC_PATH — the package-manager install)", () => {
  const names = process.platform === "win32" ? ["tectonic.exe", "tectonic"] : ["tectonic"];

  it("scans pathEnv and resolves the first dir holding a platform binary name (detection == execution)", async () => {
    const dir1 = path.join("Z:", "bin1");
    const dir2 = path.join("Z:", "bin2");
    const target = path.join(dir2, names[0]!);
    const handle = makeRunner({});
    const compiler = new TectonicCompiler({
      tectonicPath: undefined,
      warmedPath: path.join(dir, "w.json"),
      runner: handle.runner,
      fileExists: async (p) => p === target,
      pathEnv: [dir1, dir2].join(path.delimiter),
    });
    expect(await compiler.probe()).toMatchObject({ available: true, version: "0.16.9" });
    expect(handle.specs[0]!.binPath).toBe(target); // the resolved absolute path is what gets spawned
  });

  it("also tries the non-.exe `tectonic` name (a Unix binary on PATH)", async () => {
    const bindir = path.join("Z:", "bin");
    const target = path.join(bindir, "tectonic");
    const handle = makeRunner({});
    const compiler = new TectonicCompiler({
      warmedPath: path.join(dir, "w.json"),
      runner: handle.runner,
      fileExists: async (p) => p === target,
      pathEnv: bindir,
    });
    expect((await compiler.probe()).available).toBe(true);
    expect(handle.specs[0]!.binPath).toBe(target);
  });

  it("reports unavailable and never spawns when no PATH entry holds the binary", async () => {
    const handle = makeRunner({});
    const compiler = new TectonicCompiler({
      warmedPath: path.join(dir, "w.json"),
      runner: handle.runner,
      fileExists: async () => false,
      pathEnv: [path.join("Z:", "a"), path.join("Z:", "b")].join(path.delimiter),
    });
    expect(await compiler.probe()).toMatchObject({ available: false });
    expect(handle.specs).toHaveLength(0);
  });
});

describe("TectonicCompiler — resolved-path cache (decision 50)", () => {
  it("serves the cached absolute path after the binary is gone (a cache-disable mutation flips this)", async () => {
    // Default (real) fileExists so the globalThis cache is live; a unique
    // per-run path key means no cross-test collision.
    const binFile = path.join(dir, `tectonic-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await writeFile(binFile, "");
    const handle = makeRunner({});
    const compiler = new TectonicCompiler({
      tectonicPath: binFile,
      warmedPath: path.join(dir, "w.json"),
      runner: handle.runner,
    });
    expect((await compiler.probe()).available).toBe(true);
    await rm(binFile); // the binary vanishes...
    expect((await compiler.probe()).available).toBe(true); // ...but the cached path still resolves
    expect(handle.specs.every((s) => s.binPath === path.resolve(binFile))).toBe(true);
  });
});

describe("TectonicCompiler — cold network-open failure classification", () => {
  it("a non-cached exit-1 naming a connection failure is cache_missing_offline, not latex_error", async () => {
    const handle = makeRunner({
      onCompile: async () => ({
        code: 1,
        stdout: "",
        stderr: "error: failed to connect to the package bundle server",
        timedOut: false,
      }),
    });
    // No warmed marker ⇒ onlyCached false, but the bundle-fetch failure on our
    // always-valid template can only be the CDN.
    const result = await compilerAt(path.join(dir, "cold.json"), handle.runner).compile("tex", {
      timeoutMs: 600_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "cache_missing_offline" });
  });

  it("a non-cached exit-1 with a genuine LaTeX error stays latex_error", async () => {
    const handle = makeRunner({
      onCompile: async () => ({
        code: 1,
        stdout: "",
        stderr: "error: resume.tex:5: Undefined control sequence.",
        timedOut: false,
      }),
    });
    const result = await compilerAt(path.join(dir, "cold2.json"), handle.runner).compile("tex", {
      timeoutMs: 180_000,
    });
    expect(result).toMatchObject({ kind: "failed", reason: "latex_error" });
  });
});
