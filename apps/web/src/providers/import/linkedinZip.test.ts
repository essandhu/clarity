import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_ENTRY_CAP_BYTES,
  LINKEDIN_ROW_CAP,
  readLinkedinZip,
} from "./linkedinZip";

// ZIPs are built IN-TEST via fflate's zipSync — no binary fixtures. Covers
// the §7.12 pins: whitelist filter-before-inflate with the decoy-PII proof,
// the zip-bomb pair stopped on ACTUALLY-inflated bytes, the corrupt-entry
// skip, the row cap, header sniff, both Volunteering filenames, and the
// structural no-fs/no-path-join zip-slip pin.

const DECOY_EMAIL = "secret.contact@example-decoy.com";
const DECOY_IP = "203.0.113.77";

const POSITIONS_CSV =
  "Company Name,Title,Description,Location,Started On,Finished On\n" +
  'Driftlock,Platform Engineer,"Built the ingestion pipeline\nCut costs 40%",Remote,Jan 2020,Mar 2022\n';

function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const payload: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    payload[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(payload, { level: 9 });
}

/** Patch a 2-byte/4-byte little-endian field at `offset` past the header of
 *  the named entry, in BOTH the local header (PK\x03\x04) and the central
 *  directory (PK\x01\x02). */
function patchEntry(
  zip: Uint8Array,
  name: string,
  patch: { localOffset: number; centralOffset: number; bytes: number[] },
): Uint8Array {
  const out = new Uint8Array(zip);
  const nameBytes = strToU8(name);
  const matchesAt = (index: number, sig: number, nameOffset: number): boolean => {
    if (out[index] !== 0x50 || out[index + 1] !== 0x4b) return false;
    if (out[index + 2] !== sig || out[index + 3] !== sig + 1) return false;
    for (let j = 0; j < nameBytes.length; j++) {
      if (out[index + nameOffset + j] !== nameBytes[j]) return false;
    }
    return true;
  };
  let patched = 0;
  for (let i = 0; i + 4 <= out.length; i++) {
    if (matchesAt(i, 0x03, 30)) {
      patch.bytes.forEach((byte, j) => (out[i + patch.localOffset + j] = byte));
      patched += 1;
    } else if (matchesAt(i, 0x01, 46)) {
      patch.bytes.forEach((byte, j) => (out[i + patch.centralOffset + j] = byte));
      patched += 1;
    }
  }
  expect(patched).toBe(2); // both headers found, or the fixture is broken
  return out;
}

describe("readLinkedinZip — whitelist", () => {
  it("admits the 9 resume CSVs (case/space/underscore/dir-prefix tolerant) and never inflates decoys", () => {
    const zip = makeZip({
      "Positions.csv": POSITIONS_CSV,
      "Basic_LinkedInDataExport/EDUCATION.CSV": "School Name,Degree Name\nState University,BSc\n",
      "volunteer experiences.csv":
        "Company Name,Role,Cause,Started On,Finished On,Description\nFood Bank,Driver,Hunger,2019-06,,Weekly deliveries\n",
      "Connections.csv": `Notes:\n\nFirst Name,Last Name,Email Address\nJane,Doe,${DECOY_EMAIL}\n`,
      "Registration.csv": `Registered At,IP Address\n2015-01-01,${DECOY_IP}\n`,
      "messages.csv": "FROM,TO,BODY\nme,you,private message\n",
    });
    const result = readLinkedinZip(zip);
    if (!result.ok) throw new Error(result.message);

    const admitted = result.files.filter((f) => f.admitted).map((f) => f.name).sort();
    expect(admitted).toEqual([
      "Basic_LinkedInDataExport/EDUCATION.CSV",
      "Positions.csv",
      "volunteer experiences.csv",
    ]);
    const ignored = result.files.filter((f) => !f.admitted).map((f) => f.name).sort();
    expect(ignored).toEqual(["Connections.csv", "Registration.csv", "messages.csv"]);

    // The decoy-PII proof: nothing from a non-admitted file exists anywhere
    // in the result — the entries were never even inflated.
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(DECOY_EMAIL);
    expect(everything).not.toContain(DECOY_IP);
    expect(everything).not.toContain("private message");

    expect(result.rows.positions).toHaveLength(1);
    expect(result.rows.positions?.[0]?.["Company Name"]).toBe("Driftlock");
    expect(result.rows.positions?.[0]?.Description).toBe("Built the ingestion pipeline\nCut costs 40%");
    expect(result.rows.education?.[0]?.["School Name"]).toBe("State University");
    expect(result.rows.volunteering?.[0]?.Role).toBe("Driver");
  });

  it("imports Volunteering.csv under its canonical name too (the drift pair)", () => {
    const result = readLinkedinZip(
      makeZip({
        "Volunteering.csv":
          "Company Name,Role,Cause,Started On,Finished On,Description\nShelter,Mentor,Youth,Jan 2021,,\n",
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.volunteering?.[0]?.Role).toBe("Mentor");
  });

  it("handles a BOM and skips preamble lines down to the sniffed header row", () => {
    const withPreamble =
      "﻿Notes:\n" +
      '"This file contains your positions."\n' +
      "\n" +
      POSITIONS_CSV;
    const result = readLinkedinZip(makeZip({ "Positions.csv": withPreamble }));
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.positions).toHaveLength(1);
    expect(result.rows.positions?.[0]?.Title).toBe("Platform Engineer");
  });

  it("skips a whitelisted file whose expected columns never appear, with a note — and it is NOT marked parsed", () => {
    const result = readLinkedinZip(makeZip({ "Skills.csv": "Something,Else\na,b\n" }));
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.skills).toBeUndefined();
    expect(result.notes.some((note) => note.includes("expected columns"))).toBe(true);
    expect(result.files).toEqual([{ name: "Skills.csv", admitted: true, parsed: false }]); // review U4
  });

  it("tolerates ragged rows (fewer columns than the header) — relax_column_count pinned (review U9)", () => {
    const result = readLinkedinZip(
      makeZip({
        // Row 1 omits the trailing Location/Started On/Finished On fields —
        // real LinkedIn exports do this.
        "Positions.csv":
          "Company Name,Title,Description,Location,Started On,Finished On\n" +
          "Driftlock,Platform Engineer\n" +
          "Acme,Dev,Desc,NYC,Jan 2020,Mar 2021\n",
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.positions).toHaveLength(2);
    expect(result.rows.positions?.[0]?.["Company Name"]).toBe("Driftlock");
  });

  it("caps each CSV at the first 2,000 rows and says so", () => {
    const rows = Array.from({ length: LINKEDIN_ROW_CAP + 100 }, (_, i) => `Skill ${i}`).join("\n");
    const result = readLinkedinZip(makeZip({ "Skills.csv": `Name\n${rows}\n` }));
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.skills).toHaveLength(LINKEDIN_ROW_CAP);
    expect(result.notes.some((note) => note.includes("first 2,000 rows"))).toBe(true);
  });
});

describe("readLinkedinZip — zip-bomb guards (ACTUAL inflated bytes)", () => {
  it("stops a small-compressed/large-actual entry at the per-file cap; the rest still imports", () => {
    const bomb = new Uint8Array(LINKEDIN_ENTRY_CAP_BYTES + 1024 * 1024); // 11 MiB of zeros -> tiny deflate
    const zip = makeZip({
      "Positions.csv": bomb,
      "Skills.csv": "Name\nTypeScript\n",
      "Connections.csv": `First Name,Last Name,Email Address\nJane,Doe,${DECOY_EMAIL}\n`,
    });
    expect(zip.length).toBeLessThan(1024 * 1024); // proves the compressed size lied about the cost
    const result = readLinkedinZip(zip);
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.positions).toBeUndefined();
    expect(result.notes.some((note) => note.includes("safety cap"))).toBe(true);
    expect(result.rows.skills).toHaveLength(1); // the archive survived the bomb
    expect(JSON.stringify(result)).not.toContain(DECOY_EMAIL); // decoys still never surfaced
  });

  it("is not fooled by a LYING declared size — the counter reads actual bytes", () => {
    const bomb = new Uint8Array(LINKEDIN_ENTRY_CAP_BYTES + 1024 * 1024);
    let zip = makeZip({ "Positions.csv": bomb, "Skills.csv": "Name\nGo\n" });
    // Declare Positions.csv as a tiny 100-byte file in BOTH headers
    // (attacker-controlled metadata; uncompressed size is at +22 local, +24
    // central).
    zip = patchEntry(zip, "Positions.csv", {
      localOffset: 22,
      centralOffset: 24,
      bytes: [100, 0, 0, 0],
    });
    const result = readLinkedinZip(zip);
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.positions).toBeUndefined();
    expect(result.notes.some((note) => note.includes("safety cap"))).toBe(true);
    expect(result.rows.skills).toHaveLength(1);
  });

  it("rejects the whole archive when TOTAL inflated bytes pass 100 MiB", () => {
    const chunk = new Uint8Array(9 * 1024 * 1024 + 512 * 1024); // ~9.5 MiB, under the entry cap
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 11; i++) files[`copy-${i}/Positions.csv`] = chunk; // 11 × 9.5 ≈ 104.5 MiB
    const result = readLinkedinZip(makeZip(files));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("total_cap_exceeded");
  });
});

describe("readLinkedinZip — resilience", () => {
  it("skips a corrupt whitelisted entry with a note while the rest of the archive imports", () => {
    let zip = makeZip({
      "Education.csv": "School Name,Degree Name\nState University,BSc\n",
      "Skills.csv": "Name\nRust\n",
    });
    // Compression method 99 (unsupported) — start() throws, the individual
    // wrap turns it into a skip (method is at +8 local, +10 central).
    zip = patchEntry(zip, "Education.csv", { localOffset: 8, centralOffset: 10, bytes: [99, 0] });
    const result = readLinkedinZip(zip);
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.education).toBeUndefined();
    expect(result.notes.some((note) => note.includes("Education.csv"))).toBe(true);
    expect(result.rows.skills).toHaveLength(1);
    // The files log tells the truth per outcome (review U4): admitted but
    // skipped is NOT parsed.
    expect(result.files.find((f) => f.name === "Education.csv")?.parsed).toBe(false);
    expect(result.files.find((f) => f.name === "Skills.csv")?.parsed).toBe(true);
  });

  it("duplicate files of one kind: the first wins, extras are noted, all stay capped", () => {
    const result = readLinkedinZip(
      makeZip({
        "Skills.csv": "Name\nFirst\n",
        "extra/Skills.csv": "Name\nSecond\n",
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.skills).toHaveLength(1);
    expect(result.rows.skills?.[0]?.Name).toBe("First");
    expect(result.notes.some((note) => note.includes("already read"))).toBe(true);
  });

  it("garbage bytes are not a crash", () => {
    const result = readLinkedinZip(strToU8("this is not a zip archive at all"));
    // fflate either finds no entries (ok, zero files) or throws (typed
    // not_a_zip) — both are non-crash outcomes; the route 400s on either.
    if (result.ok) expect(result.files).toHaveLength(0);
    else expect(result.reason).toBe("not_a_zip");
  });
});

describe("linkedinZip — structural zip-slip pin (decision 46)", () => {
  it("never imports node:fs/node:path and never joins an entry name into a path", () => {
    const source = readFileSync(new URL("./linkedinZip.ts", import.meta.url), "utf8");
    // No fs and no path module can even be NAMED — with no path API in
    // scope, an entry name cannot become a filesystem path (Array.join on
    // strings remains; it never touches the filesystem).
    expect(source).not.toMatch(/["']node:fs["']|["']fs["']|["']node:fs\/promises["']/);
    expect(source).not.toMatch(/["']node:path["']|["']path["']|["']path\/posix["']/);
    expect(source).not.toMatch(/path\.join|\bjoinPath|writeFile|createWriteStream/);
  });
});
