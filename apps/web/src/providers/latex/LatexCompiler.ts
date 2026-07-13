// The compiler seam (PLAN-RESUME.md §4.10, decision 50). Types only — the
// PageFetcher/ProfileStore precedent: the interface is domain-safe, the
// TectonicCompiler implementation beside it is wired ONLY in deps.ts and
// consumed by routes. `probe()` drives the health chip (a local binary spawn,
// never a network dial — decision 56); `compile()` regenerates the PDF from
// server-built LaTeX only (decision 49).

/** Health-chip shape (decision 50): resolved-once availability, the parsed
 *  version, and whether the bundle CDN has already been warmed. */
export interface LatexProbe {
  available: boolean;
  version?: string;
  warmed: boolean;
}

/**
 * A single compile outcome. `pdf` carries the fresh bytes; `failed` carries the
 * typed reason taxonomy (decision 51 — `cache_missing_offline` is the
 * `--only-cached` miss that NEVER auto-retries with network) plus the filtered
 * diagnostics; `unavailable` means the binary could not be resolved at compile
 * time (the route answers 503 with per-OS install copy — decision 50).
 */
export type CompileResult =
  | { kind: "pdf"; bytes: Uint8Array }
  | {
      kind: "failed";
      reason: "latex_error" | "crashed" | "timeout" | "output_too_large" | "cache_missing_offline";
      diagnostics: string[];
    }
  | { kind: "unavailable" };

export interface CompileOptions {
  timeoutMs: number;
  /** pdf-only re-warm consent (decision 51): the ONE flag that reopens the
   *  bundle CDN — set only by an explicit, disclosed user click. */
  allowBundleDownload?: boolean;
  signal?: AbortSignal;
}

export interface LatexCompiler {
  probe(): Promise<LatexProbe>;
  compile(tex: string, opts: CompileOptions): Promise<CompileResult>;
}

// Path-appropriate compile ceilings (§4.9), here in the fs-free interface module
// so the render route can pick a timeout without statically importing the
// fs/spawn-heavy TectonicCompiler. The warm `--only-cached` compile is
// CPU-bound; the two user-consented network-open paths (unwarmed first compile,
// explicit re-warm) fetch ~43 MB and can run minutes on slow links.
export const TECTONIC_TIMEOUT_MS = 180_000;
export const TECTONIC_COLD_TIMEOUT_MS = 600_000;

/**
 * The compile ceiling (§4.9): a warm `--only-cached` compile gets the short
 * ceiling; the two user-consented network-open paths — an UNWARMED first
 * compile and an explicit re-warm — get the long one. The compiler derives
 * `--only-cached` from the SAME `(warmed, allowBundleDownload)` inputs, so the
 * flag and the timeout can never disagree. Pure so the render route's choice is
 * unit-pinnable (the describeModelSelection precedent).
 */
export function pickCompileTimeout(warmed: boolean, allowBundleDownload?: boolean): number {
  const networkOpen = !warmed || allowBundleDownload === true;
  return networkOpen ? TECTONIC_COLD_TIMEOUT_MS : TECTONIC_TIMEOUT_MS;
}
