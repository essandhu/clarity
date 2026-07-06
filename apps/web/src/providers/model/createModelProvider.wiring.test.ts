import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, streamText } from "ai";
import { createOllama } from "ai-sdk-ollama";
import { createModelProvider, DEFAULT_OLLAMA_BASE_URL } from "./createModelProvider";
import { STALL_HINT } from "./inactivityWatchdog";

// Wiring tests through a REAL built provider: these pin the construction
// knobs and the watchdog→SDK signal threading that the unit tests cannot see
// (the adversarial review proved mutations here survived the rest of the
// suite). SDK entry points are mocked; everything else is the real code path.

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});
vi.mock("ai-sdk-ollama", () => ({
  createOllama: vi.fn(() => vi.fn(() => ({ provider: "ollama-mock-model" }))),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn(() => ({ provider: "openai-mock-model" }))),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic-mock-model" }))),
}));

const mockGenerate = vi.mocked(generateText);
const mockStream = vi.mocked(streamText);
const PersonSchema = z.object({ name: z.string() });

// The provider consumes streamText().fullStream (separated reasoning must
// count as watchdog progress — see synthesisStream). These helpers script it.
type Part =
  | { type: "text-delta"; id: string; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "error"; error: unknown };
const text = (t: string): Part => ({ type: "text-delta", id: "t1", text: t });
const reasoning = (t: string): Part => ({ type: "reasoning-delta", id: "r1", text: t });
const fullStreamOf = (parts: AsyncIterable<Part>) => ({ fullStream: parts }) as never;

function lastOllamaModelFactory(): ReturnType<typeof vi.fn> {
  const result = vi.mocked(createOllama).mock.results.at(-1);
  if (!result) throw new Error("createOllama was not called");
  return result.value as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ollama construction knobs", () => {
  it("honors OLLAMA_BASE_URL (ai-sdk-ollama reads no env itself)", () => {
    createModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://elsewhere:9999" });
    expect(vi.mocked(createOllama)).toHaveBeenCalledWith({ baseURL: "http://elsewhere:9999" });
  });

  it("falls back to the default base URL when OLLAMA_BASE_URL is unset", () => {
    createModelProvider({ MODEL_PROVIDER: "ollama" });
    expect(vi.mocked(createOllama)).toHaveBeenCalledWith({ baseURL: DEFAULT_OLLAMA_BASE_URL });
  });

  it("qwen3 think: false for EXTRACTION, true for SYNTHESIS; num_ctx pinned on both", () => {
    createModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "qwen3:4b" });
    const factory = lastOllamaModelFactory();
    // Extraction: think:false (schema-constrained decoding keeps residual
    // reasoning out of the JSON). Synthesis: think:TRUE — with think unset,
    // ai-sdk-ollama drops qwen3's separated thinking before it becomes
    // stream parts, so a long think phase reads as a watchdog stall
    // (observed live 2026-07-06); true forwards reasoning-delta progress.
    // Both: num_ctx pinned — Ollama's 4096 default context-shifts the app's
    // 8k prompt budget silently.
    expect(factory).toHaveBeenNthCalledWith(1, "qwen3:4b", {
      think: false,
      reliableObjectGeneration: false,
      options: { num_ctx: 8_192 },
    });
    expect(factory).toHaveBeenNthCalledWith(2, "qwen3:4b", {
      think: true,
      reliableObjectGeneration: false,
      options: { num_ctx: 8_192 },
    });
  });

  it("extract uses the think-disabled instance; streamSynthesis the default-think one", async () => {
    mockGenerate.mockResolvedValueOnce({ output: { name: "A" }, finishReason: "stop" } as never);
    mockStream.mockReturnValueOnce(
      fullStreamOf(
        (async function* () {
          yield text("x");
        })(),
      ),
    );
    const provider = createModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "qwen3:4b" });
    await provider.extract("input", PersonSchema);
    const chunks: string[] = [];
    for await (const chunk of provider.streamSynthesis({ prompt: "p" })) chunks.push(chunk);
    const factory = lastOllamaModelFactory();
    expect(mockGenerate.mock.calls[0][0].model).toBe(factory.mock.results[0]?.value);
    expect(mockStream.mock.calls[0][0].model).toBe(factory.mock.results[1]?.value);
    expect(chunks).toEqual(["x"]);
  });

  it("sends no think param for non-thinking models (Ollama rejects it)", () => {
    createModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "llama3.2:3b" });
    expect(lastOllamaModelFactory()).toHaveBeenCalledWith("llama3.2:3b", {
      reliableObjectGeneration: false,
      options: { num_ctx: 8_192 },
    });
  });

  it("does not treat qwen3-coder as part of the thinking qwen3 family", () => {
    createModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "qwen3-coder:30b" });
    expect(lastOllamaModelFactory()).toHaveBeenCalledWith("qwen3-coder:30b", {
      reliableObjectGeneration: false,
      options: { num_ctx: 8_192 },
    });
  });
});

describe("cloud extraction provider options (PLAN.md decision 9)", () => {
  it("passes strictJsonSchema:false on openai extraction calls", async () => {
    mockGenerate.mockResolvedValueOnce({ output: { name: "A" }, finishReason: "stop" } as never);
    const provider = createModelProvider({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" });
    await provider.extract("input", PersonSchema);
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({
      providerOptions: { openai: { strictJsonSchema: false } },
    });
  });

  it("passes no provider options on anthropic extraction calls", async () => {
    mockGenerate.mockResolvedValueOnce({ output: { name: "A" }, finishReason: "stop" } as never);
    const provider = createModelProvider({
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-a",
    });
    await provider.extract("input", PersonSchema);
    expect(mockGenerate.mock.calls[0][0].providerOptions).toBeUndefined();
  });
});

describe("watchdog wiring (PLAN.md decision 15)", () => {
  it("aborts a hung extract after CLARITY_MODEL_INACTIVITY_MS via the threaded signal", async () => {
    vi.useFakeTimers();
    mockGenerate.mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) => {
          expect(options.abortSignal).toBeDefined();
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(options.abortSignal?.reason as Error),
            { once: true },
          );
        }) as never,
    );
    const provider = createModelProvider({
      MODEL_PROVIDER: "ollama",
      CLARITY_MODEL_INACTIVITY_MS: "50",
    });
    const result = provider.extract("input", PersonSchema);
    const assertion = expect(result).rejects.toMatchObject({
      code: "INTERNAL",
      hint: STALL_HINT,
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("terminates a hung extract even when the SDK ignores the abort signal", async () => {
    vi.useFakeTimers();
    mockGenerate.mockImplementationOnce(() => new Promise(() => {}) as never);
    const provider = createModelProvider({
      MODEL_PROVIDER: "ollama",
      CLARITY_MODEL_INACTIVITY_MS: "50",
    });
    const result = provider.extract("input", PersonSchema);
    const assertion = expect(result).rejects.toMatchObject({ code: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe("streamSynthesis wiring", () => {
  it("strips <think> blocks split across chunks and forwards prompt/system/signal", async () => {
    mockStream.mockReturnValueOnce(
      fullStreamOf(
        (async function* () {
          yield text("<thi");
          yield text("nk>secret</think>He");
          yield text("llo");
        })(),
      ),
    );
    const provider = createModelProvider({ MODEL_PROVIDER: "ollama" });
    const received: string[] = [];
    for await (const chunk of provider.streamSynthesis({ prompt: "p", system: "s" })) {
      received.push(chunk);
    }
    expect(received.join("")).toBe("Hello");
    expect(received.every((c) => c.length > 0)).toBe(true);
    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs).toMatchObject({ prompt: "p", system: "s" });
    expect(callArgs.abortSignal).toBeDefined();
  });

  it("counts raw chunks as progress — a long literal think block is not a stall", async () => {
    vi.useFakeTimers();
    const gapMs = 40; // < the 50ms window; total runtime 160ms > the window
    mockStream.mockReturnValueOnce(
      fullStreamOf(
        (async function* () {
          yield text("<think>");
          for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            yield text("thinking...");
          }
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          yield text("</think>done");
        })(),
      ),
    );
    const provider = createModelProvider({
      MODEL_PROVIDER: "ollama",
      CLARITY_MODEL_INACTIVITY_MS: "50",
    });
    const collected = (async () => {
      const out: string[] = [];
      for await (const chunk of provider.streamSynthesis({ prompt: "p" })) {
        out.push(chunk);
      }
      return out.join("");
    })();
    await vi.advanceTimersByTimeAsync(4 * gapMs);
    await expect(collected).resolves.toBe("done");
  });

  it("counts SEPARATED reasoning deltas as progress — a long qwen3 think phase is not a stall", async () => {
    // The live increment-7 failure: qwen3's message.thinking rides
    // 'reasoning-delta' parts that never reach the text output, so a >window
    // think phase killed a progressing run. The watchdog must reset on them.
    vi.useFakeTimers();
    const gapMs = 40; // < the 50ms window; total thinking time 160ms > the window
    mockStream.mockReturnValueOnce(
      fullStreamOf(
        (async function* () {
          for (let i = 0; i < 4; i++) {
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            yield reasoning("mulling it over");
          }
          yield text("done");
        })(),
      ),
    );
    const provider = createModelProvider({
      MODEL_PROVIDER: "ollama",
      CLARITY_MODEL_INACTIVITY_MS: "50",
    });
    const collected = (async () => {
      const out: string[] = [];
      for await (const chunk of provider.streamSynthesis({ prompt: "p" })) {
        out.push(chunk);
      }
      return out;
    })();
    await vi.advanceTimersByTimeAsync(4 * gapMs);
    const chunks = await collected;
    expect(chunks.join("")).toBe("done");
    // Progress markers never leak to consumers.
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("rethrows fullStream error parts — nothing is swallowed", async () => {
    mockStream.mockReturnValueOnce(
      fullStreamOf(
        (async function* () {
          yield text("partial");
          yield { type: "error", error: new Error("provider blew up") } as Part;
        })(),
      ),
    );
    const provider = createModelProvider({ MODEL_PROVIDER: "ollama" });
    const consume = async () => {
      const out: string[] = [];
      for await (const chunk of provider.streamSynthesis({ prompt: "p" })) out.push(chunk);
      return out;
    };
    await expect(consume()).rejects.toThrow("provider blew up");
  });
});
