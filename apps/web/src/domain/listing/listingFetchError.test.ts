import { describe, expect, it } from "vitest";
import { invalidInput } from "./listingFetchError";

const URL = "https://example.com/jobs/1";

describe("invalidInput (adversarial-review fix: honest deadline copy)", () => {
  it("a cancelled skip surfaces its detail — the deadline path must not read as a user cancel", () => {
    const err = invalidInput({
      kind: "skip",
      url: URL,
      reason: "cancelled",
      detail: "aborted: Run deadline reached after 60000 ms.",
    });
    expect(err.code).toBe("INPUT_INVALID");
    expect(err.message).toContain("the run was cancelled");
    expect(err.message).toContain("Run deadline reached after 60000 ms.");
  });

  it("a cancelled skip without detail keeps the plain copy", () => {
    const err = invalidInput({ kind: "skip", url: URL, reason: "cancelled" });
    expect(err.message).toBe("Could not read the listing page: the run was cancelled.");
  });

  it("non-cancelled skips never append detail (kept terse; detail may be noisy)", () => {
    const err = invalidInput({
      kind: "skip",
      url: URL,
      reason: "network",
      detail: "getaddrinfo EAI_AGAIN example.com",
    });
    expect(err.message).toBe("Could not read the listing page: the host could not be reached.");
    expect(err.hint).toContain("Paste the listing text");
  });

  it("http_status keeps the status-code suffix", () => {
    const err = invalidInput({ kind: "skip", url: URL, reason: "http_status", httpStatus: 503 });
    expect(err.message).toContain("(HTTP 503)");
  });
});
