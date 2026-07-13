// LinkedIn export vocabulary (PLAN-RESUME.md §4.7) — the 9-file whitelist,
// header-sniff signatures, PII column list, and the pinned date-format list.
// Pure string data/functions with zero imports: the base module for both the
// row->entry builders (linkedinEntries.ts) and the provider-side unzipper
// (linkedinZip.ts consumes the whitelist — domain never imports providers).

export type LinkedinFileKind =
  | "profile"
  | "positions"
  | "education"
  | "skills"
  | "certifications"
  | "projects"
  | "honors"
  | "languages"
  | "volunteering";

export type LinkedinRow = Record<string, string | undefined>;
export type LinkedinRows = Partial<Record<LinkedinFileKind, LinkedinRow[]>>;

/** Normalized-basename whitelist (decision 46): case-insensitive, spaces ≡
 *  underscores, tolerant of directory prefixes — including the
 *  `Volunteer Experiences.csv` filename drift. Anything else is NEVER
 *  inflated. String ops only: an entry name never touches a filesystem path. */
export function linkedinFileKind(entryName: string): LinkedinFileKind | undefined {
  const base = entryName.split("/").pop() ?? "";
  const normalized = base.toLowerCase().replace(/_/g, " ").trim();
  if (!normalized.endsWith(".csv")) return undefined;
  switch (normalized.slice(0, -4).trim()) {
    case "profile":
      return "profile";
    case "positions":
      return "positions";
    case "education":
      return "education";
    case "skills":
      return "skills";
    case "certifications":
      return "certifications";
    case "projects":
      return "projects";
    case "honors":
      return "honors";
    case "languages":
      return "languages";
    case "volunteering":
    case "volunteer experiences":
      return "volunteering";
    default:
      return undefined;
  }
}

/** Header sniff signatures (§4.7): the header row must contain these column
 *  names; preamble lines above it (the Connections.csv "Notes:" class) are
 *  skipped by the provider before csv-parse runs. */
export const LINKEDIN_HEADER_SIGNATURES: Record<LinkedinFileKind, string[]> = {
  profile: ["First Name", "Last Name"],
  positions: ["Company Name", "Title"],
  education: ["School Name"],
  skills: ["Name"],
  certifications: ["Name", "Authority"],
  projects: ["Title"],
  honors: ["Title"],
  languages: ["Name"],
  volunteering: ["Company Name", "Role"],
};

/** Dropped at the mapping boundary (decision 46) — deleted from every row
 *  BEFORE any mapper runs, so no code path can surface them. */
export const LINKEDIN_PII_COLUMNS = [
  "Birth Date",
  "Address",
  "Zip Code",
  "Geo Location",
  "Instant Messengers",
  "Twitter Handles",
] as const;

const MONTHS: Record<string, string> = {
  jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun",
  jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
  january: "Jan", february: "Feb", march: "Mar", april: "Apr", june: "Jun",
  july: "Jul", august: "Aug", september: "Sep", october: "Oct",
  november: "Nov", december: "Dec",
};
const MONTH_BY_NUMBER = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The pinned format list ["MMM YYYY","MMMM YYYY","YYYY-MM","YYYY"] -> a
 *  normalized display string, or undefined when no format matches (the
 *  caller keeps the raw string and NOTES it — never drops it). Non-English
 *  month names land in the fallback: a documented residual (risk 25). */
export function parseLinkedinDate(raw: string): string | undefined {
  const value = raw.trim();
  const monthYear = /^([A-Za-z]+) (\d{4})$/.exec(value);
  if (monthYear) {
    const month = MONTHS[monthYear[1]!.toLowerCase()];
    return month ? `${month} ${monthYear[2]}` : undefined;
  }
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(value);
  if (isoMonth) {
    const month = MONTH_BY_NUMBER[Number.parseInt(isoMonth[2]!, 10) - 1];
    return month ? `${month} ${isoMonth[1]}` : undefined;
  }
  return /^\d{4}$/.test(value) ? value : undefined;
}
