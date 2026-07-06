import { runDraft } from "@/domain/synthesis/NoteDrafter";
import { buildServerDeps } from "@/server/deps";
import { createPipelineSseStream, SSE_HEADERS } from "@/server/sse";
import { DraftRequestSchema } from "@/shared/schema";

// The streamed draft note (decision 25): the same SSE envelope as
// /api/analyze, three event types — draft.started {}, draft.delta { text },
// draft.completed { note } — or run.error. User-initiated, outside
// runAnalysis (decision 27).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { code: "INPUT_INVALID", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = DraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { profile, hooks, contact? }${issue ? ` — ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  // Same one-controller teardown as /api/analyze: client disconnect and
  // reader cancel converge on a single server-side signal that stops the
  // model stream (composed with the provider-internal watchdog).
  const cancel = new AbortController();
  const onClientGone = () => cancel.abort(new Error("client aborted the request"));
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });
  cancel.signal.addEventListener(
    "abort",
    () => console.log("[clarity] /api/draft abort checkpoint fired — tearing down draft"),
    { once: true },
  );

  const stream = createPipelineSseStream(
    (emit) =>
      runDraft(parsed.data, { getModel: deps.pipeline.getModel }, emit, {
        cancel: cancel.signal,
      }),
    { cancel },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
