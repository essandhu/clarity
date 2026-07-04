// Stateful <think>…</think> remover for streamed model text (PLAN.md decision
// 30, risk 5). ai-sdk-ollama already routes native `message.thinking` away
// from the text stream; this is the belt-and-suspenders layer for models that
// emit literal think tags inside their text content. Split out of
// createModelProvider.ts for the ~200-line file ceiling.

const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(text.slice(text.length - k))) return k;
  }
  return 0;
}

export interface ThinkStripper {
  /** Feed one chunk; returns the text safe to emit so far. */
  push(chunk: string): string;
  /** End of stream; returns any withheld text (an unclosed think block is dropped). */
  flush(): string;
}

export function createThinkStripper(): ThinkStripper {
  let buffer = "";
  let thinking = false;
  return {
    push(chunk: string): string {
      buffer += chunk;
      let out = "";
      for (;;) {
        if (thinking) {
          const idx = buffer.indexOf(CLOSE);
          if (idx === -1) {
            // Discard thought text, but keep a possible partial closing tag.
            buffer = buffer.slice(buffer.length - partialTagSuffix(buffer, CLOSE));
            return out;
          }
          buffer = buffer.slice(idx + CLOSE.length);
          thinking = false;
        } else {
          const idx = buffer.indexOf(OPEN);
          if (idx === -1) {
            // Emit everything except a possible partial opening tag.
            const keep = partialTagSuffix(buffer, OPEN);
            out += buffer.slice(0, buffer.length - keep);
            buffer = buffer.slice(buffer.length - keep);
            return out;
          }
          out += buffer.slice(0, idx);
          buffer = buffer.slice(idx + OPEN.length);
          thinking = true;
        }
      }
    },
    flush(): string {
      const tail = thinking ? "" : buffer;
      buffer = "";
      thinking = false;
      return tail;
    },
  };
}

/** One-shot variant for non-streamed text. */
export function stripThink(text: string): string {
  const stripper = createThinkStripper();
  return stripper.push(text) + stripper.flush();
}

/** Stream variant: strips think blocks and never yields empty chunks. */
export async function* stripThinkStream(source: AsyncIterable<string>): AsyncIterable<string> {
  const stripper = createThinkStripper();
  for await (const chunk of source) {
    const cleaned = stripper.push(chunk);
    if (cleaned.length > 0) yield cleaned;
  }
  const tail = stripper.flush();
  if (tail.length > 0) yield tail;
}
