import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NoObjectGeneratedError, streamText } from "ai";
import { streamExtractWithRepair } from "./streamExtract";

// The decision-58 stream-backed extract: same repair contract as
// extractWithRepair, plus onDelta pings on every model delta (the watchdog
// feed). streamText is scripted per-test; the real NoObjectGeneratedError
// class keeps isInstance() checks honest (the extractWithRepair pattern).

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn() };
});

const mockStream = vi.mocked(streamText);
const PersonSchema = z.object({ name: z.string(), city: z.string() });

type Part =
  | { type: "text-delta"; id: string; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "error"; error: unknown }
  | { type: "abort" };

function scripted(opts: {
  parts: Part[];
  output?: unknown;
  outputError?: unknown;
  finishReason?: string;
}): never {
  const output =
    opts.outputError !== undefined
      ? Promise.reject(opts.outputError)
      : Promise.resolve(opts.output);
  output.catch(() => {});
  return {
    fullStream: (async function* () {
      yield* opts.parts;
    })(),
    finishReason: Promise.resolve(opts.finishReason ?? "stop"),
    output,
  } as never;
}

function validationFailure(text: string, invalidValue: unknown): NoObjectGeneratedError {
  const zodError = PersonSchema.safeParse(invalidValue).error;
  if (!zodError) throw new Error("test fixture unexpectedly passed validation");
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    cause: zodError,
    text,
    response: { id: "resp_1", timestamp: new Date(0), modelId: "test-model" },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  });
}

const text = (t: string): Part => ({ type: "text-delta", id: "t", text: t });
const reasoning = (t: string): Part => ({ type: "reasoning-delta", id: "r", text: t });

beforeEach(() => {
  mockStream.mockReset();
});

describe("streamExtractWithRepair", () => {
  it("resolves the validated object and pings onDelta for text AND reasoning deltas", async () => {
    mockStream.mockReturnValueOnce(
      scripted({
        parts: [reasoning("hmm"), text('{"name":'), reasoning("more"), text('"Maya"...')],
        output: { name: "Maya", city: "Lisbon" },
      }),
    );
    const onDelta = vi.fn();
    const controller = new AbortController();
    const providerOptions = { openai: { strictJsonSchema: false } };
    const result = await streamExtractWithRepair({
      model: "test/model",
      input: "Maya lives in Lisbon.",
      schema: PersonSchema,
      system: "copy verbatim",
      maxOutputTokens: 900,
      abortSignal: controller.signal,
      providerOptions,
      onDelta,
    });
    expect(result).toEqual({ name: "Maya", city: "Lisbon" });
    expect(onDelta).toHaveBeenCalledTimes(4);
    // EVERY knob must reach streamText — dropping system (the copy-verbatim
    // rules), abortSignal (cancellation), or providerOptions (decision 9's
    // strictJsonSchema) previously survived the whole suite (review F1).
    const call = mockStream.mock.calls[0][0];
    expect(call).toMatchObject({
      prompt: "Maya lives in Lisbon.",
      temperature: 0,
      system: "copy verbatim",
      maxOutputTokens: 900,
      providerOptions,
    });
    expect(call.abortSignal).toBe(controller.signal);
  });

  it("repairs once on validation failure, feeding back raw text + zod issues", async () => {
    mockStream
      .mockReturnValueOnce(
        scripted({
          parts: [text('{"name":"Maya"}')],
          outputError: validationFailure('{"name":"Maya"}', { name: "Maya" }),
        }),
      )
      .mockReturnValueOnce(
        scripted({ parts: [text("fixed")], output: { name: "Maya", city: "Lisbon" } }),
      );
    const onProgress = vi.fn();
    const result = await streamExtractWithRepair({
      model: "test/model",
      input: "Maya lives in Lisbon.",
      schema: PersonSchema,
      onProgress,
    });
    expect(result).toEqual({ name: "Maya", city: "Lisbon" });
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1); // completed-but-invalid = progress
    const repairArgs = mockStream.mock.calls[1][0] as { prompt: string };
    expect(repairArgs.prompt).toContain("Maya lives in Lisbon.");
    expect(repairArgs.prompt).toContain('{"name":"Maya"}');
    expect(repairArgs.prompt).toContain("city");
  });

  it("throws EXTRACTION_FAILED after the single repair attempt also fails", async () => {
    mockStream
      .mockReturnValueOnce(
        scripted({ parts: [], outputError: validationFailure("bad", { name: "x" }) }),
      )
      .mockReturnValueOnce(
        scripted({ parts: [], outputError: validationFailure("worse", { name: "y" }) }),
      );
    await expect(
      streamExtractWithRepair({ model: "test/model", input: "in", schema: PersonSchema }),
    ).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("treats a non-stop finish reason as EXTRACTION_FAILED without repairing", async () => {
    mockStream.mockReturnValueOnce(
      scripted({ parts: [text("trunca")], output: undefined, finishReason: "length" }),
    );
    await expect(
      streamExtractWithRepair({ model: "test/model", input: "in", schema: PersonSchema }),
    ).rejects.toMatchObject({ code: "EXTRACTION_FAILED", message: expect.stringContaining("length") });
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("rethrows fullStream error parts untouched — no repair on API errors", async () => {
    mockStream.mockReturnValueOnce(
      scripted({ parts: [text("x"), { type: "error", error: new Error("provider down") }] }),
    );
    await expect(
      streamExtractWithRepair({ model: "test/model", input: "in", schema: PersonSchema }),
    ).rejects.toThrow("provider down");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("an abort part surfaces the signal's reason (the watchdog's stall error travels here)", async () => {
    const controller = new AbortController();
    const stallish = new Error("no progress for 300000 ms");
    controller.abort(stallish);
    mockStream.mockReturnValueOnce(scripted({ parts: [{ type: "abort" }] }));
    await expect(
      streamExtractWithRepair({
        model: "test/model",
        input: "in",
        schema: PersonSchema,
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(stallish);
  });
});
