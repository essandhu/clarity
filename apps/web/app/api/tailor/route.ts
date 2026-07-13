import { z } from "zod";
import { runTailor } from "@/domain/resume/TailorPipeline";
import { buildServerDeps } from "@/server/deps";
import { createPipelineSseStream, SSE_HEADERS } from "@/server/sse";
import { TailorRoleInputSchema } from "@/shared/schema";

// The tailor stream (PLAN-RESUME.md §3): the master profile is DISK truth
// loaded here, never posted by the client (decision 37). Pre-stream failures
// are plain JSON (the draft-route precedent) — an empty/unreadable profile is
// a 409 steering to the editor, and the stream never opens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TailorRequestSchema = z.object({ role: TailorRoleInputSchema });

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
  const parsed = TailorRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { role } as pasted text (40 to 50,000 characters) or a listing profile${issue ? ` — ${issue.path.join(".")}: ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  let current;
  try {
    current = await deps.profileStore.load(request.signal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      { code: "INTERNAL", message: `Profile store failure: ${detail}` },
      { status: 500 },
    );
  }
  if (current.kind === "empty") {
    return Response.json(
      {
        code: "PROFILE_MISSING",
        message:
          "No master profile is saved yet — add or import entries in the Master profile panel and Save, then tailor.",
      },
      { status: 409 },
    );
  }
  if (current.kind === "unreadable") {
    return Response.json(
      {
        code: "PROFILE_UNREADABLE",
        message:
          `The saved profile file is unreadable, so there is nothing safe to tailor from. ` +
          `Restore it from ${current.bakPath} (or start fresh in the editor) first.`,
      },
      { status: 409 },
    );
  }
  const master = current.profile;

  const cancel = new AbortController();
  const onClientGone = () => cancel.abort(new Error("client aborted the request"));
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });
  cancel.signal.addEventListener(
    "abort",
    () => console.log("[clarity] /api/tailor abort checkpoint fired — tearing down tailor run"),
    { once: true },
  );

  const stream = createPipelineSseStream(
    (emit) =>
      runTailor(
        parsed.data.role,
        master,
        { getModel: deps.pipeline.getModel },
        emit,
        { cancel: cancel.signal },
      ),
    { cancel },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
