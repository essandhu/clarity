import { renderResumeTex, resumeFilenameSlug } from "@/domain/resume/resumeLatex";
import { RenderRequestSchema } from "@/shared/schema";

// Resume render (PLAN-RESUME.md §3, decisions 48/49). Plain JSON in, a
// server-REGENERATED .tex out — client-supplied LaTeX is never compiled: the
// request schema is `.strict()`, so a body smuggling a raw `tex` field is a
// 400. Increment 14 wires `format: 'tex'` only; `format: 'pdf'` (Tectonic)
// lands in increment 15, and the .tex download is always available meanwhile.
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

  const parsed = RenderRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { resume, format: 'tex' | 'pdf' }${issue ? ` — ${issue.path.join(".")}: ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const { resume, format } = parsed.data;
  if (format === "pdf") {
    // Tectonic integration ships in increment 15; until then the .tex is the
    // deliverable (honest degradation — the feature works without a compiler).
    return Response.json(
      {
        code: "PDF_UNAVAILABLE",
        message:
          "PDF compilation is not enabled in this build yet — download the .tex and compile it with Tectonic locally.",
      },
      { status: 501 },
    );
  }

  const tex = renderResumeTex(resume);
  // The slug is [a-z0-9-]+ (or the "resume" fallback) by construction, so this
  // untrusted-listing-derived value is safe in the Content-Disposition header.
  const filename = `resume-${resumeFilenameSlug(resume.roleLabel)}.tex`;
  return new Response(tex, {
    status: 200,
    headers: {
      "content-type": "text/x-tex; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
