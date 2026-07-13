import { describe, expect, it } from "vitest";
import { pdfPageCount } from "./pdfPageCount";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("pdfPageCount", () => {
  it("counts each `/Type /Page` leaf object", () => {
    const pdf = `%PDF-1.5
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R >> endobj
5 0 obj << /Type /Page /Parent 2 0 R >> endobj
%%EOF`;
    expect(pdfPageCount(bytes(pdf))).toBe(2);
  });

  it("never counts the `/Type /Pages` tree root (the decision-52 non-match)", () => {
    const pdf = `1 0 obj << /Type /Pages /Count 0 >> endobj`;
    expect(pdfPageCount(bytes(pdf))).toBe(0);
  });

  it("returns 1 for a single-page resume", () => {
    const pdf = `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >>
3 0 obj << /Type /Page /MediaBox [0 0 612 792] >>`;
    expect(pdfPageCount(bytes(pdf))).toBe(1);
  });

  it("tolerates no whitespace and newlines between /Type and /Page", () => {
    expect(pdfPageCount(bytes("<</Type/Page>><</Type\n/Page>>"))).toBe(2);
  });

  it("does not match other /Page-prefixed names", () => {
    expect(pdfPageCount(bytes("/Type /PageLabels /Type /Pages"))).toBe(0);
  });

  it("returns 0 when the page objects are hidden in a compressed object stream", () => {
    // A real Tectonic PDF wraps objects in an /ObjStm — no plaintext /Type /Page.
    const pdf = `%PDF-1.5\n5 0 obj << /Type /ObjStm /N 6 >> stream\n<binary>\nendstream`;
    expect(pdfPageCount(bytes(pdf))).toBe(0);
  });

  it("survives binary bytes between markers (latin1 decode)", () => {
    const withBinary = new Uint8Array([
      ...bytes("<</Type /Page>>"),
      0x00,
      0xff,
      0xfe,
      0x80,
      ...bytes("<</Type /Page>>"),
    ]);
    expect(pdfPageCount(withBinary)).toBe(2);
  });
});
