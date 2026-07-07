import { describe, expect, it } from "vitest";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { CleanPage } from "@/shared/schema";
import { peekCached, settleByAbort } from "./cachePeek";

// Review finding: peeks run BEFORE a token exists, so nothing bounded them —
// a pathologically stalled disk read could hold a run open past the wall
// clock. settleByAbort is the bound: abort ⇒ fallback, rejection ⇒ fallback,
// and the abandoned promise's arms stay handled.

const NEVER = new Promise<never>(() => {});

const page: CleanPage = {
  kind: "page",
  url: "https://acme.dev/",
  finalUrl: "https://acme.dev/",
  title: "Acme",
  text: "Acme builds robots.",
  fetchedAt: "2026-07-06T12:00:00.000Z",
};

describe("settleByAbort", () => {
  it("passes a settling promise's value through untouched", async () => {
    const live = new AbortController();
    await expect(settleByAbort(Promise.resolve(42), 0, live.signal)).resolves.toBe(42);
  });

  it("resolves the fallback the moment the signal aborts a hung promise", async () => {
    const controller = new AbortController();
    const pending = settleByAbort(NEVER, "fallback", controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).resolves.toBe("fallback");
  });

  it("an already-aborted signal short-circuits to the fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(settleByAbort(NEVER, null, controller.signal)).resolves.toBeNull();
  });

  it("a rejecting promise becomes the fallback, never a throw", async () => {
    const live = new AbortController();
    await expect(
      settleByAbort(Promise.reject(new Error("disk exploded")), "safe", live.signal),
    ).resolves.toBe("safe");
    await expect(settleByAbort(Promise.reject(new Error("no signal")), "safe")).resolves.toBe(
      "safe",
    );
  });
});

describe("peekCached — bounded by the caller's deadline signal", () => {
  it("a hung cached() resolves null at the abort instead of hanging the run", async () => {
    const fetcher: PageFetcher = {
      cached: () => NEVER,
      fetchClean: async () => {
        throw new Error("unreachable");
      },
    };
    const controller = new AbortController();
    const pending = peekCached(fetcher, "https://acme.dev/", controller.signal);
    controller.abort(new Error("run deadline"));
    await expect(pending).resolves.toBeNull();
  });

  it("a healthy hit still resolves with a live signal", async () => {
    const fetcher: PageFetcher = {
      cached: async () => page,
      fetchClean: async () => {
        throw new Error("unreachable");
      },
    };
    const live = new AbortController();
    await expect(peekCached(fetcher, "https://acme.dev/", live.signal)).resolves.toEqual(page);
  });
});
