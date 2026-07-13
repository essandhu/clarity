import { describe, expect, it } from "vitest";
import { readBodyCapped } from "./readCapped";

// §4.7's reader-loop cap: Content-Length is never trusted, the counter runs
// on actually-received bytes, and an over-cap body is rejected MID-STREAM —
// the source is cancelled, never drained into memory.

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe("readBodyCapped", () => {
  it("returns the concatenated bytes for an under-cap body", async () => {
    const result = await readBodyCapped(
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
      10,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.bytes]).toEqual([1, 2, 3]);
  });

  it("rejects the moment the counter passes the cap and cancels the source", async () => {
    let cancelled = false;
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readBodyCapped(endless, 4096);
    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
    // The loop stopped at the trip point instead of draining the source.
    expect(produced).toBeLessThanOrEqual(6);
  });

  it("a null body is an empty payload, not a crash", async () => {
    const result = await readBodyCapped(null, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toHaveLength(0);
  });
});
