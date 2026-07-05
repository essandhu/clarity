import { describe, expect, it } from "vitest";
import { validateListingInput } from "./ListingInputForm";

// Pure validation mirror (adversarial-review fix): the too_big side of the
// text bound must get its own copy — "paste at least 40 characters" on a 60k
// paste told users the opposite of the truth.

describe("validateListingInput", () => {
  it("accepts valid text and a valid trimmed url", () => {
    const text = validateListingInput("text", {
      text: "Driftlock is hiring a Backend Engineer to build data pipelines in Go.",
      url: "",
    });
    expect(text).toHaveProperty("input", expect.objectContaining({ kind: "text" }));

    const url = validateListingInput("url", { text: "", url: "  https://example.com/jobs/1  " });
    expect(url).toHaveProperty(
      "input",
      expect.objectContaining({ kind: "url", url: "https://example.com/jobs/1" }),
    );
  });

  it("too-short text asks for more", () => {
    const result = validateListingInput("text", { text: "too short", url: "" });
    expect(result).toHaveProperty("error", expect.stringContaining("at least 40 characters"));
  });

  it("over-limit text names the 50k cap instead of asking for MORE text", () => {
    const result = validateListingInput("text", { text: "x".repeat(50_001), url: "" });
    expect(result).toHaveProperty("error", expect.stringContaining("50,000-character limit"));
    expect((result as { error: string }).error).not.toContain("at least 40");
  });

  it("rejects non-http(s) and malformed urls with the link message", () => {
    for (const url of ["not a url", "javascript:alert(1)", "ftp://example.com/x"]) {
      expect(validateListingInput("url", { text: "", url })).toHaveProperty(
        "error",
        expect.stringContaining("http(s) link"),
      );
    }
  });
});
