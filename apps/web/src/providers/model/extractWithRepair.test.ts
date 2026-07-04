import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, NoObjectGeneratedError } from "ai";
import { extractWithRepair } from "./extractWithRepair";

// Partial mock: generateText is scripted per-test; the real
// NoObjectGeneratedError class is kept so isInstance() checks stay honest.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

const mockGenerate = vi.mocked(generateText);
type GenerateResult = Awaited<ReturnType<typeof generateText>>;

const PersonSchema = z.object({ name: z.string(), city: z.string() });

function ok(output: unknown): GenerateResult {
  return { output, finishReason: "stop" } as unknown as GenerateResult;
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

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("extractWithRepair", () => {
  it("returns the validated object on first success, at temperature 0", async () => {
    mockGenerate.mockResolvedValueOnce(ok({ name: "Maya", city: "Lisbon" }));
    const result = await extractWithRepair({
      model: "test/model",
      input: "Maya lives in Lisbon.",
      schema: PersonSchema,
    });
    expect(result).toEqual({ name: "Maya", city: "Lisbon" });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({
      prompt: "Maya lives in Lisbon.",
      temperature: 0,
    });
  });

  it("repairs once on validation failure, feeding back raw text + zod issues", async () => {
    const failure = validationFailure('{"name":"Maya"}', { name: "Maya" });
    mockGenerate
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(ok({ name: "Maya", city: "Lisbon" }));

    const result = await extractWithRepair({
      model: "test/model",
      input: "Maya lives in Lisbon.",
      schema: PersonSchema,
    });

    expect(result).toEqual({ name: "Maya", city: "Lisbon" });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const repairArgs = mockGenerate.mock.calls[1][0] as { prompt: string };
    expect(repairArgs.prompt).toContain("Maya lives in Lisbon.");
    expect(repairArgs.prompt).toContain('{"name":"Maya"}');
    expect(repairArgs.prompt).toContain("city"); // the zod issue names the missing field
  });

  it("throws EXTRACTION_FAILED after the single repair attempt also fails", async () => {
    mockGenerate
      .mockRejectedValueOnce(validationFailure("not json", { name: "Maya" }))
      .mockRejectedValueOnce(validationFailure("still not json", { name: "Maya" }));

    await expect(
      extractWithRepair({ model: "test/model", input: "input", schema: PersonSchema }),
    ).rejects.toMatchObject({ name: "PipelineError", code: "EXTRACTION_FAILED" });
    // Exactly one repair — never a second.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-validation errors untouched with no repair attempt", async () => {
    const network = new Error("ECONNRESET");
    mockGenerate.mockRejectedValueOnce(network);
    await expect(
      extractWithRepair({ model: "test/model", input: "input", schema: PersonSchema }),
    ).rejects.toBe(network);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("fails as EXTRACTION_FAILED on truncation (finish reason 'length'), with no repair", async () => {
    mockGenerate.mockResolvedValueOnce({
      output: undefined,
      finishReason: "length",
    } as unknown as GenerateResult);
    await expect(
      extractWithRepair({ model: "test/model", input: "input", schema: PersonSchema }),
    ).rejects.toMatchObject({ name: "PipelineError", code: "EXTRACTION_FAILED" });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("reports the settled-but-invalid first attempt as watchdog progress", async () => {
    const onProgress = vi.fn();
    mockGenerate
      .mockRejectedValueOnce(validationFailure('{"name":"Maya"}', { name: "Maya" }))
      .mockResolvedValueOnce(ok({ name: "Maya", city: "Lisbon" }));
    await extractWithRepair({
      model: "test/model",
      input: "input",
      schema: PersonSchema,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("does not report progress when the first attempt already succeeds", async () => {
    const onProgress = vi.fn();
    mockGenerate.mockResolvedValueOnce(ok({ name: "Maya", city: "Lisbon" }));
    await extractWithRepair({
      model: "test/model",
      input: "input",
      schema: PersonSchema,
      onProgress,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rethrows an abort untouched — cancellation is not repairable", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    mockGenerate.mockRejectedValueOnce(abort);
    await expect(
      extractWithRepair({ model: "test/model", input: "input", schema: PersonSchema }),
    ).rejects.toBe(abort);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
