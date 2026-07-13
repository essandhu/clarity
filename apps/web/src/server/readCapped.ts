// Capped request-body reader (PLAN-RESUME.md §4.7): App-Router handlers have
// no default body-size limit and Content-Length is attacker-controlled, so
// the LinkedIn route consumes request.body through THIS loop — a running
// byte counter that rejects the moment the cap trips. An oversized body is
// never buffered whole; the source is cancelled mid-stream.

export const LINKEDIN_BODY_CAP_BYTES = 200 * 1024 * 1024;

export type CappedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; readBytes: number };

export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<CappedBody> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;
      total += value.length;
      if (total > capBytes) {
        await reader.cancel().catch(() => undefined); // stop the source NOW
        return { ok: false, readBytes: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}
