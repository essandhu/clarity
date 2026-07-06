import { PipelineEventSchema, type PipelineEvent } from "@/shared/schema";
import { createSseParser } from "./parseSse";

// The one client-side SSE pump (PLAN.md §6 Transport), shared by the analysis
// run and the draft stream: POST → reader → parseSse → zod re-validate (the
// client trusts the schema, not the wire) → seq-stamped dispatch. Garbled or
// unknown frames are dropped, never fatal; a stream that closes without a
// terminal frame and without a user abort becomes a transport_error.

export type SsePumpAction =
  | { seq: number; event: PipelineEvent }
  | { type: "transport_error"; message?: string };

export async function pumpSseRun(opts: {
  url: string;
  body: unknown;
  controller: AbortController;
  isTerminal: (event: PipelineEvent) => boolean;
  dispatch: (action: SsePumpAction) => void;
}): Promise<void> {
  const { controller, dispatch } = opts;
  let sawTerminal = false;
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      dispatch({ type: "transport_error", message: await readErrorMessage(res) });
      return;
    }
    const reader = res.body.getReader();
    const parser = createSseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) {
        const event = parseEvent(frame.data);
        if (!event) continue;
        const seq = Number(frame.id);
        if (!Number.isInteger(seq)) continue; // our server always stamps id
        if (opts.isTerminal(event)) sawTerminal = true;
        dispatch({ seq, event });
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      dispatch({
        type: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (!controller.signal.aborted && !sawTerminal) dispatch({ type: "transport_error" });
}

function parseEvent(data: string): PipelineEvent | undefined {
  try {
    const parsed = PipelineEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Non-JSON error body — fall through to the status line.
  }
  return `The server rejected the request (HTTP ${res.status}).`;
}
