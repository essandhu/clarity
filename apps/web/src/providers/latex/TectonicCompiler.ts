import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CompileOptions, CompileResult, LatexCompiler, LatexProbe } from "./LatexCompiler";
import { spawnRunner } from "./tectonicRunner";

// The compile timeouts live in the fs-free LatexCompiler module so the render
// route can import them without pulling this fs/spawn module into its trace;
// re-exported here for callers already reaching for the compiler.
export { TECTONIC_COLD_TIMEOUT_MS, TECTONIC_TIMEOUT_MS } from "./LatexCompiler";

// The Tectonic implementation of LatexCompiler (PLAN-RESUME.md §4.9, decisions
// 50/51). Detection resolves the binary once (TECTONIC_PATH else a PATH scan),
// caches the ABSOLUTE path on globalThis (HMR-safe, the robots-cache
// precedent) so detection and execution can never disagree, and reports it via
// the health chip. Compile runs in a fresh mkdtemp dir with `--untrusted` +
// TECTONIC_UNTRUSTED_MODE=1; `--only-cached` is added once the bundle is warmed
// (and NOT re-opening the CDN on this request), and an only-cached failure is
// the typed `cache_missing_offline` — it NEVER auto-retries with network
// (decision 51). Success needs exit 0 AND a fresh resume.pdf (a crash can leave
// stale output). The child-process spawn is the one injected seam.

export interface RunSpec {
  binPath: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type TectonicRunner = (spec: RunSpec) => Promise<RunResult>;

export const PROBE_TIMEOUT_MS = 2_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024; // expansion-bomb guard on the read

export interface TectonicDeps {
  /** TECTONIC_PATH, read once in deps.ts (§4.10) — never from process.env here. */
  tectonicPath?: string;
  /** data/tectonic/warmed.json — the bundle-warmed marker (decision 51). */
  warmedPath: string;
  runner?: TectonicRunner;
  fileExists?: (p: string) => Promise<boolean>;
  /** Spawn env base; TECTONIC_UNTRUSTED_MODE is layered on top. */
  env?: NodeJS.ProcessEnv;
  /** PATH to scan when no TECTONIC_PATH is set. */
  pathEnv?: string;
}

const realFileExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

export class TectonicCompiler implements LatexCompiler {
  private readonly tectonicPath?: string;
  private readonly warmedPath: string;
  private readonly runner: TectonicRunner;
  private readonly fileExists: (p: string) => Promise<boolean>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathEnv?: string;

  constructor(deps: TectonicDeps) {
    this.tectonicPath = deps.tectonicPath;
    this.warmedPath = deps.warmedPath;
    this.runner = deps.runner ?? spawnRunner;
    this.fileExists = deps.fileExists ?? realFileExists;
    this.env = deps.env ?? process.env;
    this.pathEnv = deps.pathEnv ?? process.env.PATH;
  }

  async probe(): Promise<LatexProbe> {
    const warmed = await this.isWarmed();
    const bin = await this.resolveBinary();
    if (!bin) return { available: false, warmed };
    const result = await this.runner({
      binPath: bin,
      args: ["--version"],
      timeoutMs: PROBE_TIMEOUT_MS,
      env: this.spawnEnv(),
    });
    const version = /Tectonic\s+([\d.]+)/i.exec(result.stdout)?.[1];
    if (result.timedOut || result.code !== 0 || version === undefined) {
      return { available: false, warmed };
    }
    return { available: true, version, warmed };
  }

  async compile(tex: string, opts: CompileOptions): Promise<CompileResult> {
    const bin = await this.resolveBinary();
    if (!bin) return { kind: "unavailable" };

    const onlyCached = (await this.isWarmed()) && !opts.allowBundleDownload;
    const dir = await mkdtemp(path.join(os.tmpdir(), "clarity-tex-"));
    try {
      await writeFile(path.join(dir, "resume.tex"), tex, "utf8");
      const args = ["-X", "compile", "resume.tex", "--outdir", dir, "--untrusted"];
      if (onlyCached) args.push("--only-cached");

      const result = await this.runner({
        binPath: bin,
        args,
        cwd: dir,
        env: this.spawnEnv(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      const diagnostics = extractDiagnostics(result.stderr);
      if (result.timedOut) return { kind: "failed", reason: "timeout", diagnostics };

      const pdfStat = await statOrNull(path.join(dir, "resume.pdf"));
      if (result.code !== 0 || pdfStat === null) {
        return {
          kind: "failed",
          reason: classifyFailure(result.code, pdfStat !== null, onlyCached, result.stderr),
          diagnostics,
        };
      }
      if (pdfStat.size > MAX_PDF_BYTES) return { kind: "failed", reason: "output_too_large", diagnostics };

      const bytes = new Uint8Array(await readFile(path.join(dir, "resume.pdf")));
      await this.markWarmed(); // first success turns on --only-cached for every future compile
      return { kind: "pdf", bytes };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async resolveBinary(): Promise<string | null> {
    const useCache = this.fileExists === realFileExists;
    const key = this.tectonicPath?.trim() || "<scan>";
    if (useCache) {
      const cached = pathCache().get(key);
      if (cached) return cached;
    }
    let resolved: string | null = null;
    if (this.tectonicPath?.trim()) {
      resolved = (await this.fileExists(this.tectonicPath)) ? path.resolve(this.tectonicPath) : null;
    } else {
      resolved = await this.scanPath();
    }
    if (useCache && resolved) pathCache().set(key, resolved);
    return resolved;
  }

  private async scanPath(): Promise<string | null> {
    if (!this.pathEnv) return null;
    const names = process.platform === "win32" ? ["tectonic.exe", "tectonic"] : ["tectonic"];
    for (const entry of this.pathEnv.split(path.delimiter)) {
      if (!entry) continue;
      for (const name of names) {
        const candidate = path.join(entry, name);
        if (await this.fileExists(candidate)) return candidate;
      }
    }
    return null;
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    // Belt-and-braces: the env var forces untrusted mode regardless of flags.
    return { ...this.env, TECTONIC_UNTRUSTED_MODE: "1" };
  }

  private async isWarmed(): Promise<boolean> {
    try {
      JSON.parse(await readFile(this.warmedPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }

  private async markWarmed(): Promise<void> {
    try {
      await mkdir(path.dirname(this.warmedPath), { recursive: true });
      await writeFile(this.warmedPath, JSON.stringify({ warmedAt: new Date().toISOString() }), "utf8");
    } catch {
      // A warmed-marker write failure must never fail an otherwise-good compile.
    }
  }
}

/** exit 0 + no PDF, or a crash-shaped exit, is a crash; an only-cached miss —
 *  or a network-open compile that couldn't reach the bundle CDN — on our
 *  always-valid template is a missing bundle; anything else is LaTeX. */
function classifyFailure(
  code: number | null,
  pdfExists: boolean,
  onlyCached: boolean,
  stderr: string,
): "latex_error" | "crashed" | "cache_missing_offline" {
  if (isCrashCode(code) || (code === 0 && !pdfExists)) return "crashed";
  // The .tex is always valid (server-regenerated + escaped), so a non-cached
  // exit-1 that names a connection/download failure is the CDN, not the resume.
  if (onlyCached || looksLikeBundleFetchFailure(stderr)) return "cache_missing_offline";
  return "latex_error";
}

/** Tectonic's bundle-fetch failure lines (offline first compile) — kept
 *  specific so a genuine LaTeX error is not swept into the bundle bucket. */
function looksLikeBundleFetchFailure(stderr: string): boolean {
  return /failed to (connect|fetch|download|resolve)|could not (connect|resolve|fetch|download)|connection (refused|reset|timed out)|unable to (connect|resolve)|network (is )?(error|unreachable)|no such host|temporary failure in name resolution|dns error/i.test(
    stderr,
  );
}

/** Tectonic exits 1 on a LaTeX error; a Windows structured-exception crash
 *  (e.g. 0xC0000409) surfaces as a large/negative code or a signal kill. */
function isCrashCode(code: number | null): boolean {
  return code === null || code < 0 || code > 2;
}

function extractDiagnostics(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^\s*error:/i.test(line) && !/fontconfig/i.test(line))
    .slice(0, 50);
}

async function statOrNull(p: string): Promise<{ size: number } | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

const PATH_CACHE_KEY = Symbol.for("clarity.tectonic.pathCache");
function pathCache(): Map<string, string> {
  const store = globalThis as { [PATH_CACHE_KEY]?: Map<string, string> };
  store[PATH_CACHE_KEY] ??= new Map();
  return store[PATH_CACHE_KEY];
}
