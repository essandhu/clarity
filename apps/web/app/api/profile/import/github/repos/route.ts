import { githubFailureStatus, isGithubImportError } from "@/providers/import/githubFetch";
import { buildServerDeps } from "@/server/deps";
import { GithubReposRequestSchema } from "@/shared/schema";

// Stage A of the GitHub import (PLAN-RESUME.md §3/§4.6): { username } ->
// repo list + rate info — 2 REST requests keyless (+1 GraphQL pin query
// with a token). Plain JSON, model-free, user-initiated (health never dials
// GitHub — decision 56).
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
  const parsed = GithubReposRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        code: "INPUT_INVALID",
        message:
          "Expected { username } — 1 to 39 letters, digits, or hyphens (GitHub's username charset).",
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  try {
    return Response.json(await deps.githubImporter.listRepos(parsed.data.username, request.signal));
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
