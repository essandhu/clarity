import { randomUUID } from "node:crypto";
import { runResumeImport } from "@/domain/profile/ResumeImportPipeline";
import { buildServerDeps } from "@/server/deps";
import { createPipelineSseStream, SSE_HEADERS } from "@/server/sse";
import { ResumeImportRequestSchema } from "@/shared/schema";

// The pasted-resume import stream (PLAN-RESUME.md §3): SSE because it holds
// a multi-minute CPU model call — profile.import.started {} at seq 0,
// heartbeats, then profile.import.completed { entries, report } XOR
// run.error. Ids and provenance are minted HERE (injected into the domain —
// node:crypto never in domain, §4.4).
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
  const parsed = ResumeImportRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { text } of 40 to 50,000 characters${issue ? ` — ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  const cancel = new AbortController();
  const onClientGone = () => cancel.abort(new Error("client aborted the request"));
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });
  cancel.signal.addEventListener(
    "abort",
    () =>
      console.log(
        "[clarity] /api/profile/import/resume abort checkpoint fired — tearing down import",
      ),
    { once: true },
  );

  const stream = createPipelineSseStream(
    (emit) =>
      runResumeImport(
        parsed.data.text,
        {
          getModel: deps.pipeline.getModel,
          mintId: () => randomUUID(),
          now: () => new Date().toISOString(),
        },
        emit,
        { cancel: cancel.signal },
      ),
    { cancel },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
