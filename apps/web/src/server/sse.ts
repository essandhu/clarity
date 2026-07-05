import type { PipelineEvent } from "@/shared/schema";

// PipelineEvent -> SSE frame adapter (PLAN.md §3). Stamps the monotonic seq
// into `id:` (the client dedups on it), encodes frames, runs the heartbeat
// timer, and closes on abort. The domain never sees any of this — it just
// calls emit.

export const HEARTBEAT_MS = 10_000;

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Belt-and-braces for reverse proxies; local-first, but costs nothing.
  "x-accel-buffering": "no",
} as const;

export interface PipelineSseOpts {
  /**
   * The run-teardown controller, shared with the route: the route aborts it
   * when the client disconnects (request.signal), and this stream aborts it
   * when the reader cancels — both paths converge on ONE server-side signal
   * (§3 Transport). Once aborted, nothing further is enqueued.
   */
  cancel: AbortController;
  heartbeatMs?: number;
}

export function createPipelineSseStream(
  run: (emit: (event: PipelineEvent) => void) => Promise<void>,
  opts: PipelineSseOpts,
): ReadableStream<Uint8Array> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const encoder = new TextEncoder();
  let seq = 0;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        stopHeartbeat();
        try {
          controller.close();
        } catch {
          // Already closed or errored — nothing left to release.
        }
      };
      const send = (event: PipelineEvent) => {
        if (closed) return;
        const frame = `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        seq += 1;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // The consumer is gone; drop everything from here on.
          closed = true;
          stopHeartbeat();
        }
      };

      heartbeat = setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
      if (opts.cancel.signal.aborted) close();
      else opts.cancel.signal.addEventListener("abort", close, { once: true });

      // run.started is emitted synchronously inside runAnalysis, so it always
      // beats the first heartbeat to seq 0 (§3: run.started is always seq 0).
      void run(send)
        .catch((err: unknown) => {
          // runAnalysis never rejects by contract; if a bug breaks that, the
          // stream still ends with a terminal frame instead of hanging.
          const detail = err instanceof Error ? err.message : String(err);
          send({ type: "run.error", code: "INTERNAL", message: `Pipeline crashed: ${detail}` });
        })
        .finally(close);
    },
    cancel() {
      // Reader cancelled — the client is gone. Tear the run down.
      closed = true;
      stopHeartbeat();
      opts.cancel.abort(new Error("client disconnected"));
    },
  });
}
