import type { ZodType } from "zod";
import type { GenOpts, ModelProvider, SynthesisPrompt } from "./ModelProvider";

// Scripted ModelProvider for tests and offline dev. Extraction results are
// still parsed through the caller's schema, so a drifting fixture fails the
// test instead of silently passing shape-invalid data downstream.

export interface FakeModelScript {
  /** Consumed in order, one per extract() call. */
  extractions?: unknown[];
  /** Consumed in order, one chunk array per streamSynthesis() call. */
  streams?: string[][];
}

export class FakeModelProvider implements ModelProvider {
  readonly id = "fake";
  readonly extractCalls: { input: string; opts?: GenOpts }[] = [];
  readonly streamCalls: SynthesisPrompt[] = [];
  private readonly extractions: unknown[];
  private readonly streams: string[][];

  constructor(script: FakeModelScript = {}) {
    this.extractions = [...(script.extractions ?? [])];
    this.streams = [...(script.streams ?? [])];
  }

  async extract<T>(input: string, schema: ZodType<T>, opts?: GenOpts): Promise<T> {
    this.extractCalls.push({ input, opts });
    opts?.abortSignal?.throwIfAborted();
    if (this.extractions.length === 0) {
      throw new Error("FakeModelProvider: no scripted extraction result left");
    }
    return schema.parse(this.extractions.shift());
  }

  async *streamSynthesis(prompt: SynthesisPrompt): AsyncIterable<string> {
    this.streamCalls.push(prompt);
    const chunks = this.streams.shift();
    if (chunks === undefined) {
      throw new Error("FakeModelProvider: no scripted stream left");
    }
    for (const chunk of chunks) {
      prompt.abortSignal?.throwIfAborted();
      yield chunk;
    }
  }
}
