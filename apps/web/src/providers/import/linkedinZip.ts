import { parse } from "csv-parse/sync";
import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import {
  LINKEDIN_HEADER_SIGNATURES,
  linkedinFileKind,
  type LinkedinFileKind,
  type LinkedinRow,
  type LinkedinRows,
} from "@/domain/profile/linkedinCsv";

// Whitelist unzip for the LinkedIn export (decision 46): every entry NAME is
// examined, only whitelist matches are ever inflated (fflate's streaming
// Unzip — a non-admitted entry's stream is simply never started), and the
// zip-bomb guards count ACTUALLY-inflated bytes chunk by chunk (declared
// central-directory sizes are attacker-controlled and never trusted),
// terminating the stream the moment a cap trips. Each admitted entry is
// individually wrapped: a corrupt CSV is skipped with a note, never a dead
// import. This module NEVER imports node:fs and never joins an entry name
// into a path — zip-slip is impossible by pinned structural property (a
// static test asserts both). Everything stays in memory.

export const LINKEDIN_ENTRY_CAP_BYTES = 10 * 1024 * 1024;
export const LINKEDIN_TOTAL_CAP_BYTES = 100 * 1024 * 1024;
export const LINKEDIN_ROW_CAP = 2000;

export interface LinkedinZipFile {
  name: string;
  admitted: boolean;
  /** True only when this entry's rows actually landed (inflated intact,
   *  first of its kind, csv-parsed) — the route's "Read:" line must never
   *  claim a file that was admitted but then skipped (review U4). */
  parsed: boolean;
}

export type LinkedinZipResult =
  | { ok: true; rows: LinkedinRows; files: LinkedinZipFile[]; notes: string[] }
  | { ok: false; reason: "total_cap_exceeded" | "not_a_zip"; message: string };

interface InflatedEntry {
  kind: LinkedinFileKind;
  name: string;
  record: LinkedinZipFile; // shared with the files log — parsed set on success
  chunks: Uint8Array[];
  bytes: number;
  failed?: string; // the report note when skipped
  finished: boolean;
}

export function readLinkedinZip(bytes: Uint8Array): LinkedinZipResult {
  const files: LinkedinZipFile[] = [];
  const entries: InflatedEntry[] = [];
  let totalBytes = 0;
  let totalTripped = false;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const kind = linkedinFileKind(file.name);
    if (kind === undefined) {
      files.push({ name: file.name, admitted: false, parsed: false });
      return; // NEVER inflated — the whitelist is the filter, pre-inflation
    }
    const record: LinkedinZipFile = { name: file.name, admitted: true, parsed: false };
    files.push(record);
    const entry: InflatedEntry = { kind, name: file.name, record, chunks: [], bytes: 0, finished: false };
    entries.push(entry);
    file.ondata = (err, chunk, final) => {
      if (entry.failed !== undefined || totalTripped) return;
      if (err) {
        entry.failed = `${entry.name}: could not be read (corrupt entry) — skipped.`;
        entry.chunks = [];
        return;
      }
      if (chunk !== undefined && chunk.length > 0) {
        entry.bytes += chunk.length;
        totalBytes += chunk.length;
        if (totalBytes > LINKEDIN_TOTAL_CAP_BYTES) {
          totalTripped = true; // the whole archive is hostile — typed failure
          safeTerminate(file);
          return;
        }
        if (entry.bytes > LINKEDIN_ENTRY_CAP_BYTES) {
          entry.failed =
            `${entry.name}: skipped — it inflated past ` +
            `${LINKEDIN_ENTRY_CAP_BYTES / (1024 * 1024)} MiB (the per-file safety cap).`;
          entry.chunks = [];
          safeTerminate(file);
          return;
        }
        entry.chunks.push(chunk);
      }
      if (final) entry.finished = true;
    };
    try {
      file.start();
    } catch {
      entry.failed = `${entry.name}: could not be read (unsupported compression) — skipped.`;
    }
  };

  try {
    // Pushed in 1 MiB slices: bounds how many files one push handles (the
    // fflate stack-depth guidance) without changing the byte accounting.
    const STEP = 1 << 20;
    if (bytes.length === 0) unzipper.push(new Uint8Array(0), true);
    for (let offset = 0; offset < bytes.length && !totalTripped; offset += STEP) {
      const end = Math.min(bytes.length, offset + STEP);
      unzipper.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch {
    return {
      ok: false,
      reason: "not_a_zip",
      message: "That file could not be read as a ZIP archive.",
    };
  }

  if (totalTripped) {
    return {
      ok: false,
      reason: "total_cap_exceeded",
      message:
        `The archive inflated past ${LINKEDIN_TOTAL_CAP_BYTES / (1024 * 1024)} MiB ` +
        `and was rejected (zip-bomb guard).`,
    };
  }

  const notes: string[] = [];
  const rows: LinkedinRows = {};
  for (const entry of entries) {
    if (entry.failed !== undefined) {
      notes.push(entry.failed);
      continue;
    }
    if (!entry.finished) {
      notes.push(`${entry.name}: incomplete in the archive — skipped.`);
      continue;
    }
    if (rows[entry.kind] !== undefined) {
      notes.push(`${entry.name}: ignored — a ${entry.kind} file was already read.`);
      continue;
    }
    const parsed = parseCsvEntry(entry, notes);
    if (parsed !== undefined) {
      rows[entry.kind] = parsed;
      entry.record.parsed = true;
    }
  }
  return { ok: true, rows, files, notes };
}

/** Decode + header-sniff + csv-parse one admitted entry; undefined = skipped
 *  (its note already pushed). */
function parseCsvEntry(entry: InflatedEntry, notes: string[]): LinkedinRow[] | undefined {
  const text = new TextDecoder("utf-8").decode(concat(entry.chunks));
  const signature = LINKEDIN_HEADER_SIGNATURES[entry.kind];
  // Skip preamble lines (the "Notes:" class) down to the header row.
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => signature.every((column) => line.includes(column)));
  if (headerIndex === -1) {
    notes.push(`${entry.name}: expected columns (${signature.join(", ")}) not found — skipped.`);
    return undefined;
  }
  const body = headerIndex === 0 ? text : lines.slice(headerIndex).join("\n");
  let records: LinkedinRow[];
  try {
    records = parse(body, {
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      to: LINKEDIN_ROW_CAP + 1, // +1 so truncation is detectable and honest
    }) as LinkedinRow[];
  } catch {
    notes.push(`${entry.name}: could not be parsed as CSV — skipped.`);
    return undefined;
  }
  if (records.length > LINKEDIN_ROW_CAP) {
    notes.push(`${entry.name}: only the first ${LINKEDIN_ROW_CAP.toLocaleString()} rows were read.`);
    return records.slice(0, LINKEDIN_ROW_CAP);
  }
  return records;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function safeTerminate(file: UnzipFile): void {
  try {
    file.terminate();
  } catch {
    // Termination is best-effort; the cap flags already stop consumption.
  }
}
