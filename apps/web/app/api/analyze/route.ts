import { runAnalysis } from "@/domain/pipeline/AnalysisPipeline";
import { buildServerDeps } from "@/server/deps";
import { createPipelineSseStream, SSE_HEADERS } from "@/server/sse";
import { AnalyzeInputSchema } from "@/shared/schema";

// SSE over a streamed POST (PLAN.md decision 4). jsdom needs Node, and the
// stream route must never be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Pre-stream body-validation failure is plain HTTP 400 JSON — the stream
  // never opens (§3). Everything after this returns 200 + frames.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { code: "INPUT_INVALID", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = AnalyzeInputSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected {kind:'url',url} or {kind:'text',text}${issue ? ` — ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  // ONE server-side teardown controller (§3 Transport): the request signal's
  // abort listener and the ReadableStream cancel() callback both converge on
  // it; it stops in-flight fetches (composed into BudgetTokens) and model
  // calls (threaded as the extract abortSignal).
  const cancel = new AbortController();
  const onClientGone = () => cancel.abort(new Error("client aborted the request"));
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });
  cancel.signal.addEventListener(
    "abort",
    () => console.log("[clarity] /api/analyze abort checkpoint fired — tearing down run"),
    { once: true },
  );

  const stream = createPipelineSseStream(
    (emit) =>
      runAnalysis(parsed.data, deps.pipeline, emit, { cancel: cancel.signal }).finally(() => {
        if (cancel.signal.aborted) {
          console.log("[clarity] /api/analyze run settled after abort — model call stopped");
        }
      }),
    { cancel },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
