import { pickCompileTimeout } from "@/providers/latex/LatexCompiler";
import { buildServerDeps } from "@/server/deps";
import { renderResumeTex, resumeFilenameSlug } from "@/domain/resume/resumeLatex";
import { RenderRequestSchema } from "@/shared/schema";

// Resume render (PLAN-RESUME.md §3, decisions 48/49/50/51). Plain JSON in, a
// server-REGENERATED .tex out — client-supplied LaTeX is never compiled: the
// request schema is `.strict()`, so a body smuggling a raw `tex` field is a
// 400. `format: 'tex'` returns the source (increment 14); `format: 'pdf'`
// compiles it with Tectonic (increment 15) — 503 TECTONIC_MISSING with per-OS
// install copy when the binary is absent (the .tex stays the deliverable), 422
// COMPILE_FAILED with the reason taxonomy otherwise.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TECTONIC_MISSING_MESSAGE =
  "Tectonic isn't installed. Install it via Scoop (Windows), Homebrew (macOS), " +
  "pacman or conda (Linux), or the GitHub release binary, then set TECTONIC_PATH — " +
  "the .tex download always works meanwhile.";

const COMPILE_FAILED_MESSAGE: Record<string, string> = {
  // The .tex is always server-regenerated and escaped, so a LaTeX error is never
  // the resume's content — point at Tectonic's own diagnostics, don't blame it.
  latex_error: "Tectonic couldn't produce a PDF. See the details below.",
  crashed: "Tectonic crashed during compilation.",
  timeout: "Compilation timed out.",
  output_too_large: "The compiled PDF was unexpectedly large and was rejected.",
  cache_missing_offline:
    "The LaTeX support packages aren't available. Re-download them (~43 MB) to compile.",
};

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

  const { resume, format, allowBundleDownload } = parsed.data;
  // The ONE source of truth for both formats — regenerated from the domain, so
  // the .tex a user downloads is byte-identical to what the PDF is compiled from.
  const tex = renderResumeTex(resume);
  const slug = resumeFilenameSlug(resume.roleLabel);

  if (format === "tex") {
    // The slug is [a-z0-9-]+ (or the "resume" fallback) by construction, so this
    // untrusted-listing-derived value is safe in the Content-Disposition header.
    return new Response(tex, {
      status: 200,
      headers: {
        "content-type": "text/x-tex; charset=utf-8",
        "content-disposition": `attachment; filename="resume-${slug}.tex"`,
        "cache-control": "no-store",
      },
    });
  }

  const compiler = buildServerDeps().latexCompiler;
  const probe = await compiler.probe();
  if (!probe.available) {
    return Response.json({ code: "TECTONIC_MISSING", message: TECTONIC_MISSING_MESSAGE }, { status: 503 });
  }

  const result = await compiler.compile(tex, {
    timeoutMs: pickCompileTimeout(probe.warmed, allowBundleDownload),
    allowBundleDownload,
    signal: request.signal,
  });

  if (result.kind === "pdf") {
    // Re-wrap into a fresh ArrayBuffer-backed view: the compiler's Uint8Array
    // is generic over ArrayBufferLike (which includes SharedArrayBuffer) and so
    // does not satisfy BlobPart/BodyInit under newer TS libs; the copy narrows.
    const pdf = new Uint8Array(result.bytes);
    return new Response(new Blob([pdf], { type: "application/pdf" }), {
      status: 200,
      headers: {
        "content-disposition": `attachment; filename="resume-${slug}.pdf"`,
        "cache-control": "no-store",
      },
    });
  }
  if (result.kind === "unavailable") {
    return Response.json({ code: "TECTONIC_MISSING", message: TECTONIC_MISSING_MESSAGE }, { status: 503 });
  }
  return Response.json(
    {
      code: "COMPILE_FAILED",
      reason: result.reason,
      message: COMPILE_FAILED_MESSAGE[result.reason] ?? "Compilation failed.",
      diagnostics: result.diagnostics,
    },
    { status: 422 },
  );
}
