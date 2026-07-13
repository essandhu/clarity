import { githubFailureStatus, isGithubImportError } from "@/providers/import/githubFetch";
import { buildServerDeps } from "@/server/deps";
import { GithubImportRequestSchema } from "@/shared/schema";

// Stage B of the GitHub import (PLAN-RESUME.md §3/§4.6): { username,
// repos[] } -> project entries + report. One SERIAL /languages request per
// ticked repo with rate pre-checks; skipped repos are NAMED in report.notes.
// Imports never auto-save (decision 42) — the client merges, the user saves.
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
  const parsed = GithubImportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: "Expected { username, repos } — 1 to 30 repository names to import.",
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  try {
    return Response.json(
      await deps.githubImporter.importRepos(parsed.data.username, parsed.data.repos, request.signal),
    );
  } catch (err) {
    return githubFailure(err);
  }
}

function githubFailure(err: unknown): Response {
  if (isGithubImportError(err)) {
    return Response.json(
      { code: err.code.toUpperCase(), message: err.message },
      { status: githubFailureStatus(err.code) },
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return Response.json(
    { code: "INTERNAL", message: `GitHub import failure: ${detail}` },
    { status: 500 },
  );
}
