import { buildServerDeps } from "@/server/deps";
import { ProfilePutRequestSchema } from "@/shared/schema";

// Master-profile load/save (PLAN-RESUME.md §3, decision 47) — plain JSON, no
// model call. PUT refuses to blind-overwrite an unreadable file: the 409
// steers the user to the explicit overwrite consent naming the .bak.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const deps = buildServerDeps();
  try {
    return Response.json(await deps.profileStore.load(request.signal));
  } catch (err) {
    return storeFailure(err);
  }
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { code: "INPUT_INVALID", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = ProfilePutRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { profile, overwrite? }${issue ? ` — ${issue.path.join(".")}: ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  try {
    const current = await deps.profileStore.load(request.signal);
    if (current.kind === "unreadable" && parsed.data.overwrite !== true) {
      return Response.json(
        {
          code: "PROFILE_UNREADABLE",
          message:
            `The saved profile file is unreadable and was NOT overwritten. ` +
            `Restore it from ${current.bakPath}, or save again with overwrite ` +
            `enabled to move the unreadable file aside.`,
        },
        { status: 409 },
      );
    }
    await deps.profileStore.save(parsed.data.profile, request.signal);
    return Response.json({ savedAt: new Date().toISOString() });
  } catch (err) {
    return storeFailure(err);
  }
}

function storeFailure(err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return Response.json(
    { code: "INTERNAL", message: `Profile store failure: ${detail}` },
    { status: 500 },
  );
}
