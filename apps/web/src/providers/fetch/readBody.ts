import { TooLargeError } from "./resilience";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
// RFC 9309 §2.4: parsers must handle at least 500 KiB of robots.txt and may
// ignore the rest — so oversized robots files are truncated, not rejected.
export const MAX_ROBOTS_BYTES = 512 * 1024;

// An unconsumed undici body keeps its connection reserved — guard paths that
// bail before reading must cancel the stream.
export function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

async function readUpTo(
  res: Response,
  limitBytes: number,
): Promise<{ text: string; overflowed: boolean }> {
  if (!res.body) return { text: await res.text(), overflowed: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflowed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > limitBytes) {
      // Keep only what fits — truncate mode must not return the whole chunk.
      chunks.push(value.subarray(0, limitBytes - bytes));
      bytes = limitBytes;
      overflowed = true;
      reader.cancel().catch(() => {});
      break;
    }
    bytes += value.byteLength;
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // utf-8; charset sniffing is a v1.1 nicety.
  return { text: new TextDecoder().decode(all), overflowed };
}

/** Page bodies: exceeding the cap is a too_large failure. */
export async function readBodyCapped(res: Response, limitBytes: number): Promise<string> {
  const { text, overflowed } = await readUpTo(res, limitBytes);
  if (overflowed) throw new TooLargeError(limitBytes);
  return text;
}

/** robots.txt bodies: parse the first `limitBytes`, ignore the rest. */
export async function readBodyTruncated(res: Response, limitBytes: number): Promise<string> {
  const { text } = await readUpTo(res, limitBytes);
  return text;
}
