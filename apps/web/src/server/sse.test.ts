import { describe, expect, it, vi } from "vitest";
import { runAnalysis } from "@/domain/pipeline/AnalysisPipeline";
import { PipelineError } from "@/domain/pipeline/errors";
import { stubFetcher, stubModel } from "@/domain/listing/extractorTestKit";
import type { PipelineEvent } from "@/shared/schema";
import { PipelineEventSchema } from "@/shared/schema";
import { createPipelineSseStream } from "./sse";

interface DecodedFrame {
  id: number;
  event: string;
  data: PipelineEvent;
}

function decodeFrames(raw: string): DecodedFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = Object.fromEntries(
        block.split("\n").map((line) => {
          const idx = line.indexOf(": ");
          return [line.slice(0, idx), line.slice(idx + 2)];
        }),
      ) as Record<string, string>;
      return {
        id: Number(lines.id),
        event: lines.event,
        data: PipelineEventSchema.parse(JSON.parse(lines.data)),
      };
    });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const started: PipelineEvent = {
  type: "run.started",
  runId: "r1",
  provider: { id: "stub" },
  budget: { maxFetches: 12, deadlineMs: 60_000 },
  input: { kind: "text" },
};
const completed: PipelineEvent = {
  type: "run.completed",
  runId: "r1",
  elapsedMs: 5,
  fetchCount: 0,
};

describe("createPipelineSseStream", () => {
  it("encodes id/event/data frames with a monotonic seq from 0 and closes on completion", async () => {
    const stream = createPipelineSseStream(
      async (emit) => {
        emit(started);
        emit(completed);
      },
      { cancel: new AbortController() },
    );
    const frames = decodeFrames(await readAll(stream));
    expect(frames.map((f) => f.id)).toEqual([0, 1]);
    expect(frames.map((f) => f.event)).toEqual(["run.started", "run.completed"]);
    expect(frames[0].data).toMatchObject({ type: "run.started", runId: "r1" });
  });

  it("interleaves heartbeats during a quiet model call, run.started still seq 0", async () => {
    const stream = createPipelineSseStream(
      (emit) => {
        emit(started); // synchronous, like runAnalysis
        return new Promise((resolve) =>
          setTimeout(() => {
            emit(completed);
            resolve();
          }, 60),
        );
      },
      { cancel: new AbortController(), heartbeatMs: 20 },
    );
    const frames = decodeFrames(await readAll(stream));
    expect(frames[0]).toMatchObject({ id: 0, event: "run.started" });
    expect(frames.filter((f) => f.event === "heartbeat").length).toBeGreaterThanOrEqual(1);
    expect(frames.at(-1)).toMatchObject({ event: "run.completed" });
    // ids stay monotonic across heartbeats + events
    const ids = frames.map((f) => f.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("a rejecting run still terminates the stream with run.error INTERNAL", async () => {
    const stream = createPipelineSseStream(
      async () => {
        throw new Error("kaboom");
      },
      { cancel: new AbortController() },
    );
    const frames = decodeFrames(await readAll(stream));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toMatchObject({ type: "run.error", code: "INTERNAL" });
    expect((frames[0].data as { message: string }).message).toContain("kaboom");
  });

  it("reader.cancel() aborts the shared teardown controller and stops the heartbeat", async () => {
    const cancel = new AbortController();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    let runResolved = false;
    const stream = createPipelineSseStream(
      (emit) =>
        new Promise((resolve) => {
          emit(started);
          cancel.signal.addEventListener("abort", () => {
            runResolved = true;
            resolve(); // a well-behaved run returns silently on abort
          });
        }),
      { cancel, heartbeatMs: 10_000 },
    );
    const reader = stream.getReader();
    await reader.read(); // run.started
    await reader.cancel();
    expect(cancel.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(runResolved).toBe(true));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("route-side abort closes the stream without a terminal frame; late emits are dropped", async () => {
    const cancel = new AbortController();
    let lateEmit: ((event: PipelineEvent) => void) | undefined;
    const stream = createPipelineSseStream(
      (emit) =>
        new Promise((resolve) => {
          emit(started);
          lateEmit = emit;
          cancel.signal.addEventListener("abort", resolve);
        }),
      { cancel },
    );
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    cancel.abort(new Error("client went away"));
    expect(() => lateEmit?.(completed)).not.toThrow(); // dropped, not crashed
    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("pairs outstanding steps before run.error on a thrown PipelineError (integration with runAnalysis)", async () => {
    const failure = new PipelineError("EXTRACTION_FAILED", "no valid JSON", {
      stage: "extraction",
    });
    const stream = createPipelineSseStream(
      (emit) =>
        runAnalysis(
          { kind: "text", text: "Driftlock is hiring a Backend Engineer for data pipelines." },
          {
            providerId: "stub",
            getModel: () => stubModel([failure]),
            fetcher: stubFetcher(),
            clock: { now: () => 0 },
            budget: { maxFetches: 12, deadlineMs: 60_000 },
            newRunId: () => "r-pair",
          },
          emit,
          { cancel: new AbortController().signal },
        ),
      { cancel: new AbortController() },
    );
    const frames = decodeFrames(await readAll(stream));
    const eventTypes = frames.map((f) => f.event);
    const pairIndex = eventTypes.indexOf("step.finished");
    const errorIndex = eventTypes.indexOf("run.error");
    expect(pairIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBe(eventTypes.length - 1);
    expect(pairIndex).toBeLessThan(errorIndex);
    expect(frames[pairIndex].data).toMatchObject({
      status: "skipped",
      skip: { reason: "cancelled" },
    });
  });
});
