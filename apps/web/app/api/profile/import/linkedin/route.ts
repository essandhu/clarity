import { randomUUID } from "node:crypto";
import { mapLinkedinRows } from "@/domain/profile/linkedinMapping";
import { readLinkedinZip, type LinkedinZipFile } from "@/providers/import/linkedinZip";
import { LINKEDIN_BODY_CAP_BYTES, readBodyCapped } from "@/server/readCapped";
import type { ImportReport } from "@/shared/schema";

// LinkedIn data-export import (PLAN-RESUME.md §3/§4.7): multipart ZIP ->
// entries + report, entirely in memory — the raw ZIP and its CSVs are never
// written to disk, and nothing persists until the user merges and saves
// (decision 42). The body rides the capped reader loop: Content-Length is
// never trusted and an oversized body is rejected mid-stream.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return badRequest('Send the export ZIP as multipart/form-data with a "file" field.');
  }
  const body = await readBodyCapped(request.body, LINKEDIN_BODY_CAP_BYTES);
  if (!body.ok) {
    return badRequest(
      `That upload is over the ${LINKEDIN_BODY_CAP_BYTES / (1024 * 1024)} MiB limit. ` +
        `Use LinkedIn's 10-minute fast-tier export ("the works" minus media) instead of the ` +
        `full ~24h archive — note the fast tier lacks Volunteering and Profile Summary.`,
    );
  }

  let file: unknown;
  try {
    const form = await new Response(body.bytes, {
      headers: { "content-type": contentType },
    }).formData();
    file = form.get("file");
  } catch {
    return badRequest("The multipart body could not be parsed.");
  }
  if (!(file instanceof Blob)) {
    return badRequest('Attach the LinkedIn export ZIP as the "file" field.');
  }

  const zip = readLinkedinZip(new Uint8Array(await file.arrayBuffer()));
  if (!zip.ok) {
    return badRequest(zip.message);
  }
  const admitted = zip.files.filter((entry) => entry.admitted);
  if (admitted.length === 0) {
    return badRequest(
      "No resume CSVs were found in that ZIP — it doesn't look like a LinkedIn data export. " +
        'In LinkedIn: Settings & Privacy → Data privacy → "Get a copy of your data".',
    );
  }

  const importedAt = new Date().toISOString();
  const mapped = mapLinkedinRows(zip.rows, { mintId: () => randomUUID(), importedAt });
  const report: ImportReport = {
    droppedStrings: mapped.droppedStrings,
    truncated: false,
    notes: [...fileNotes(zip.files), ...zip.notes, ...mapped.notes],
  };
  return Response.json({ entries: mapped.entries, report });
}

/** The whitelist made visible (§3): which files were read vs ignored. The
 *  "Read:" line lists only files whose rows actually landed — an admitted
 *  file that was then skipped (corrupt, duplicate, header mismatch) has its
 *  own skip note and must not read as used (review U4). */
function fileNotes(files: LinkedinZipFile[]): string[] {
  const read = files.filter((entry) => entry.parsed).map((entry) => entry.name);
  const ignored = files.filter((entry) => !entry.admitted).map((entry) => entry.name);
  const notes = [read.length > 0 ? `Read: ${read.join(", ")}.` : "Read: none — no resume CSV could be used."];
  if (ignored.length > 0) {
    const shown = ignored.slice(0, 30);
    const more = ignored.length - shown.length;
    notes.push(
      `Ignored (not resume data — never opened): ${shown.join(", ")}` +
        `${more > 0 ? ` and ${more} more` : ""}.`,
    );
  }
  return notes;
}

function badRequest(message: string): Response {
  return Response.json({ code: "INPUT_INVALID", message }, { status: 400 });
}
