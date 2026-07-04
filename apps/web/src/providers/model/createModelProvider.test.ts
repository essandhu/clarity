import { describe, expect, it } from "vitest";
import { isPipelineError, PipelineError } from "@/domain/pipeline/errors";
import { createModelProvider } from "./createModelProvider";

function captureError(fn: () => unknown): PipelineError {
  try {
    fn();
  } catch (err) {
    if (isPipelineError(err)) return err;
    throw new Error(`threw a non-PipelineError: ${String(err)}`);
  }
  throw new Error("expected createModelProvider to throw");
}

describe("createModelProvider", () => {
  it("throws MODEL_UNCONFIGURED naming the exact env vars when nothing is set", () => {
    const err = captureError(() => createModelProvider({}));
    expect(err.code).toBe("MODEL_UNCONFIGURED");
    const text = `${err.message} ${err.hint}`;
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("MODEL_PROVIDER=ollama");
  });

  it("throws MODEL_UNCONFIGURED when MODEL_PROVIDER=openai has no key", () => {
    const err = captureError(() => createModelProvider({ MODEL_PROVIDER: "openai" }));
    expect(err.code).toBe("MODEL_UNCONFIGURED");
    expect(err.message).toContain("OPENAI_API_KEY");
  });

  it("throws MODEL_UNCONFIGURED when MODEL_PROVIDER=anthropic has no key", () => {
    const err = captureError(() => createModelProvider({ MODEL_PROVIDER: "anthropic" }));
    expect(err.code).toBe("MODEL_UNCONFIGURED");
    expect(err.message).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects an unknown MODEL_PROVIDER value", () => {
    const err = captureError(() => createModelProvider({ MODEL_PROVIDER: "banana" }));
    expect(err.code).toBe("MODEL_UNCONFIGURED");
    expect(err.message).toContain('"banana"');
  });

  it("auto-detects openai from a present key", () => {
    expect(createModelProvider({ OPENAI_API_KEY: "sk-test" }).id).toBe("openai");
  });

  it("treats a blank MODEL_PROVIDER as unset so key auto-detection still works", () => {
    expect(createModelProvider({ MODEL_PROVIDER: "  ", OPENAI_API_KEY: "sk-test" }).id).toBe(
      "openai",
    );
  });

  it("auto-detects anthropic from a present key", () => {
    expect(createModelProvider({ ANTHROPIC_API_KEY: "sk-ant-test" }).id).toBe("anthropic");
  });

  it("prefers openai when both keys are present and nothing is explicit", () => {
    expect(
      createModelProvider({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" }).id,
    ).toBe("openai");
  });

  it("lets an explicit MODEL_PROVIDER override auto-detection", () => {
    expect(
      createModelProvider({
        MODEL_PROVIDER: "anthropic",
        OPENAI_API_KEY: "sk-test",
        ANTHROPIC_API_KEY: "sk-ant-test",
      }).id,
    ).toBe("anthropic");
  });

  it("selects ollama explicitly with no key required", () => {
    expect(createModelProvider({ MODEL_PROVIDER: "ollama" }).id).toBe("ollama");
  });
});
