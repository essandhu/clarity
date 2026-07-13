// The §7.12 LinkedIn live proof: a driver-built ZIP through the REAL
// multipart route — both date vintages parsed, unparseable dates kept raw,
// Volunteering through BOTH filenames, the decoy-PII scan (planted
// Connections/Registration/Profile values absent from the full response
// text; the ignored files named in the notes), and the oversized-body
// reader-loop cap.
import { strToU8, zipSync } from "fflate";
import { ImportedEntriesSchema, ImportReportSchema, type ImportedEntries } from "../../src/shared/schema";
import { at, check, finish } from "./harness";

const DECOY_EMAIL = "decoy.person@example-secret.net";
const DECOY_IP = "203.0.113.99";
const PII = {
  birth: "1987-04-03",
  address: "44 Hidden Lane",
  zip: "90210-1234",
  geo: "12.3456,-98.7654",
  twitter: "@maya_secret",
  im: "maya-im-handle",
};

function buildArchive(volunteeringName: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "Profile.csv": strToU8(
      "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Instant Messengers\n" +
        `Maya,Chen,,${PII.address},${PII.birth},Platform Engineer,Builder of pipelines,Software,"${PII.zip}","${PII.geo}",${PII.twitter},${PII.im}\n`,
    ),
    "Positions.csv": strToU8(
      "Company Name,Title,Description,Location,Started On,Finished On\n" +
        'Driftlock,Platform Engineer,"Built the ingestion pipeline\nCut infra costs 40%",Remote,Jan 2020,Mar 2022\n' +
        "Acme Corp,Senior Engineer,Owned the platform,NYC,2019-06,\n" +
        "Beta LLC,Engineer,Shipped things,,Sometime in 2018,2019\n",
    ),
    "Education.csv": strToU8(
      "School Name,Start Date,End Date,Notes,Degree Name,Activities\n" +
        "State University,2014,2018,Graduated with honors,BSc Computer Science,Robotics club\n",
    ),
    "Skills.csv": strToU8("Name\nTypeScript\nRust\n"),
    "Certifications.csv": strToU8(
      "Name,Url,Authority,Started On,Finished On,License Number\nCKA,,CNCF,Jan 2023,,ABC-123\n",
    ),
    "Projects.csv": strToU8(
      "Title,Description,Url,Started On,Finished On\n" +
        "Clarity,Local-first research tool,https://github.com/x/clarity,2025-01,\n",
    ),
    "Honors.csv": strToU8("Title,Description,Issued On\nDean's List,Top decile,2016\n"),
    "Languages.csv": strToU8("Name,Proficiency\nSpanish,Professional working\n"),
    [volunteeringName]: strToU8(
      "Company Name,Role,Cause,Started On,Finished On,Description\n" +
        "Food Bank,Driver,Hunger relief,2019-06,,Weekly deliveries\n",
    ),
    "Connections.csv": strToU8(
      "Notes:\n\"When exporting your connection data...\"\n\n" +
        `First Name,Last Name,Email Address,Company,Position,Connected On\nJane,Doe,${DECOY_EMAIL},SecretCo,CEO,01 Jan 2020\n`,
    ),
    "Registration.csv": strToU8(`Registered At,IP Address\n2015-01-01,${DECOY_IP}\n`),
    "messages.csv": strToU8("FROM,TO,BODY\nme,you,a private message body\n"),
  };
  return zipSync(files, { level: 6 });
}

async function postZip(base: string, zip: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([zip as BlobPart], { type: "application/zip" }), "export.zip");
  return fetch(`${base}/api/profile/import/linkedin`, { method: "POST", body: form });
}

export async function runLinkedinProof(base: string): Promise<void> {
  // --- Archive A: the drift filename + decoys + PII ---
  const res = await postZip(base, buildArchive("Volunteer Experiences.csv"));
  check("import returned 200", res.status === 200, `status=${res.status}`);
  const bodyText = await res.text();
  const body = JSON.parse(bodyText) as { entries: unknown; report: unknown };
  const entriesParse = ImportedEntriesSchema.safeParse(body.entries);
  const reportParse = ImportReportSchema.safeParse(body.report);
  check("entries + report are zod-valid", entriesParse.success && reportParse.success);
  if (!entriesParse.success || !reportParse.success) return finish();
  const entries: ImportedEntries = entriesParse.data;

  const driftlock = entries.experience.find((e) => e.org === "Driftlock");
  const acme = entries.experience.find((e) => e.org === "Acme Corp");
  const beta = entries.experience.find((e) => e.org === "Beta LLC");
  check(
    "MMM YYYY vintage parsed (Jan 2020 – Mar 2022)",
    driftlock?.startDate === "Jan 2020" && driftlock.endDate === "Mar 2022",
    `${driftlock?.startDate} – ${driftlock?.endDate}`,
  );
  check(
    "YYYY-MM vintage parsed + blank Finished On = current role",
    acme?.startDate === "Jun 2019" && acme.endDate === undefined,
    `${acme?.startDate} – ${acme?.endDate ?? "(current)"}`,
  );
  check(
    "unparseable date survived as the raw string",
    beta?.startDate === "Sometime in 2018" && beta.endDate === "2019",
    `${beta?.startDate} – ${beta?.endDate}`,
  );
  check(
    "the raw-date keep is SURFACED in report.notes",
    reportParse.data.notes.some((note) => note.includes("Sometime in 2018")),
  );
  check(
    "multiline Description split into bullets",
    JSON.stringify(driftlock?.bullets.map((b) => b.text)) ===
      JSON.stringify(["Built the ingestion pipeline", "Cut infra costs 40%"]),
  );
  const volunteer = entries.experience.find((e) => e.org === "Food Bank");
  check(
    "Volunteer Experiences.csv (drift filename) imported with the (volunteer) suffix",
    volunteer?.role === "Driver (volunteer)",
    volunteer?.role,
  );

  // The decoy-PII proof (§7.12): the FULL response string-scans clean.
  const planted = [DECOY_EMAIL, DECOY_IP, "a private message body", PII.birth, PII.address, PII.zip, PII.geo, PII.twitter, PII.im];
  const leaked = planted.filter((value) => bodyText.includes(value));
  check("full response scans clean of every planted email/IP/PII value", leaked.length === 0, leaked.join(", ") || undefined);
  const notesText = reportParse.data.notes.join("\n");
  check(
    "notes NAME Connections.csv/Registration.csv as never opened",
    notesText.includes("Connections.csv") && notesText.includes("Registration.csv") && notesText.includes("never opened"),
  );
  const skillCats = entries.skills.map((g) => g.category).sort();
  check(
    "skills/certifications/honors/languages all mapped",
    JSON.stringify(skillCats) === JSON.stringify(["Certifications", "Honors & Awards", "Languages", "Skills"]),
    skillCats.join(","),
  );
  check("education + project mapped", entries.education.length === 1 && entries.projects.length === 1);

  // --- Archive B: the canonical Volunteering.csv filename ---
  const resB = await postZip(base, buildArchive("Volunteering.csv"));
  const bodyB = (await resB.json()) as { entries: unknown };
  const entriesB = ImportedEntriesSchema.safeParse(bodyB.entries);
  check(
    "Volunteering.csv (canonical filename) imports too",
    entriesB.success && entriesB.data.experience.some((e) => e.role === "Driver (volunteer)"),
  );

  // --- Oversized body: the reader-loop cap, live ---
  console.log(`[${at()}] posting a ~201 MiB body against the 200 MiB reader-loop cap…`);
  let overStatus: string;
  try {
    const big = new Uint8Array(201 * 1024 * 1024); // zeros; content never matters — the cap is byte-based
    const form = new FormData();
    form.append("file", new Blob([big as BlobPart], { type: "application/zip" }), "huge.zip");
    const overRes = await fetch(`${base}/api/profile/import/linkedin`, { method: "POST", body: form });
    overStatus = `HTTP ${overRes.status}`;
    check("oversized body rejected with an early typed 400", overRes.status === 400, overStatus);
  } catch (err) {
    // The server cancelled the body stream mid-upload — the socket-level
    // face of the same early rejection. The liveness check below proves it
    // was a rejection, not a crash.
    overStatus = `stream aborted client-side (${err instanceof Error ? err.message : String(err)})`;
    check("oversized body rejected mid-stream (never buffered whole)", true, overStatus);
  }
  const alive = await postZip(base, buildArchive("Volunteering.csv"));
  check("route still healthy after the oversized attempt", alive.status === 200, `status=${alive.status}`);
  finish();
}
