import type { ZodType } from "zod";

// The §4.1 ModelProvider seam. This file is types-only: it is one of the five
// provider interface files src/domain/** is allowed to import (eslint layering
// rule) — implementations are wired in by src/server/deps.

export interface GenOpts {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Decision 58 (PLAN-RESUME.md): run this extraction stream-backed so every
   * model delta feeds the inactivity watchdog as progress — the window then
   * applies BETWEEN deltas, never to the whole call. For long extractions on
   * slow CPU (resume import, tailor selection) a healthy call can exceed the
   * whole-call window; v1 calls keep the proven promise path.
   */
  streamProgress?: boolean;
}

export interface SynthesisPrompt {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ModelProvider {
  id: "openai" | "anthropic" | "ollama" | string;
  /** Structured extraction: resolves to data validated against the given zod schema. */
  extract<T>(input: string, schema: ZodType<T>, opts?: GenOpts): Promise<T>;
  /** Streaming synthesis: yields text chunks for the UI. */
  streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string>;
}
