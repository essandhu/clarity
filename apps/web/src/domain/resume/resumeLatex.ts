import type {
  EducationEntry,
  MasterProfile,
  SkillGroup,
  TailoredEntry,
  TailoredResume,
} from "@/shared/schema";
import { escapeLatexText, escapeLatexUrl, latexEmailField } from "./latexEscape";
import { RESUME_PREAMBLE } from "./resumePreamble";

// TailoredResume -> a complete .tex (PLAN-RESUME.md decision 48, §4.8). The
// model never writes LaTeX; every interpolated string flows through the ONE
// `slot()` choke point (escapeLatexText), and the section headings are fixed
// template constants — so no profile/model text can form a control sequence.
// Empty sections are omitted entirely. The document is self-contained: dates
// are mechanically joined and identity/education are already master copies, so
// the render never re-reads the store.

/** The ONE interpolation choke point: every dynamic string a slot renders
 *  passes through here. */
const slot = (value: string): string => escapeLatexText(value);

type Identity = MasterProfile["identity"];

export function renderResumeTex(resume: TailoredResume): string {
  const experience = resume.entries.filter((entry) => entry.kind === "experience");
  const projects = resume.entries.filter((entry) => entry.kind === "project");

  const sections = [
    header(resume.identity),
    educationSection(resume.education),
    experienceSection(experience),
    projectsSection(projects),
    skillsSection(resume.skills),
  ].filter((block) => block.length > 0);

  return `${RESUME_PREAMBLE}
\\begin{document}

${sections.join("\n\n\n")}

\\end{document}
`;
}

function header(identity: Identity): string {
  // Order: phone, email (mailto rule), location, then links — each present
  // item joined by " $|$ ". Absent optionals contribute nothing.
  const parts: string[] = [];
  if (identity.phone) parts.push(slot(identity.phone));
  if (identity.email) parts.push(latexEmailField(identity.email));
  if (identity.location) parts.push(slot(identity.location));
  for (const link of identity.links) {
    parts.push(String.raw`\href{${escapeLatexUrl(link.url)}}{${slot(link.label)}}`);
  }
  const contact = parts.length > 0 ? `\n    \\small ${parts.join(" $|$ ")}` : "";
  return `\\begin{center}
    \\textbf{\\Huge \\scshape ${slot(identity.name)}} \\\\ \\vspace{1pt}${contact}
\\end{center}`;
}

function educationSection(education: EducationEntry[]): string {
  if (education.length === 0) return "";
  const rows = education
    .map((edu) =>
      subheading(
        edu.school,
        edu.location ?? "",
        edu.degree ?? "",
        eduDates(edu.startDate, edu.endDate),
      ),
    )
    .join("\n");
  return `%-----------EDUCATION-----------
\\section{Education}
  \\resumeSubHeadingListStart
${rows}
  \\resumeSubHeadingListEnd`;
}

function experienceSection(entries: TailoredEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => {
      const head = subheading(
        entry.heading,
        entry.location ?? "",
        entry.subheading ?? "",
        entry.dates ?? "",
      );
      return `${head}${bulletList(entry)}`;
    })
    .join("\n\n");
  return `%-----------EXPERIENCE-----------
\\section{Experience}
  \\resumeSubHeadingListStart

${rows}

  \\resumeSubHeadingListEnd`;
}

function projectsSection(entries: TailoredEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => {
      const name = entry.url
        ? String.raw`\href{${escapeLatexUrl(entry.url)}}{\textbf{${slot(entry.heading)}}}`
        : String.raw`\textbf{${slot(entry.heading)}}`;
      const tech = entry.subheading ? String.raw` $|$ \emph{${slot(entry.subheading)}}` : "";
      const heading = `    \\resumeProjectHeading\n      {${name}${tech}}{${slot(entry.dates ?? "")}}`;
      return `${heading}${bulletList(entry)}`;
    })
    .join("\n\n");
  return `%-----------PROJECTS-----------
\\section{Projects}
  \\resumeSubHeadingListStart

${rows}

  \\resumeSubHeadingListEnd`;
}

function skillsSection(skills: SkillGroup[]): string {
  if (skills.length === 0) return "";
  // Each group is one line "\textbf{cat}{: items}"; only interior lines carry
  // the trailing "\\" (an empty itemize or a trailing \\ before }} is avoided).
  const lines = skills
    .map((group) => `     \\textbf{${slot(group.category)}}{: ${group.items.map(slot).join(", ")}}`)
    .join(" \\\\\n");
  return `%-----------PROGRAMMING SKILLS-----------
\\section{Technical Skills}
 \\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
${lines}
    }}
 \\end{itemize}`;
}

/** Jake's `\resumeSubheading{#1 bold}{#2 top-right}{#3 italic}{#4 bottom-right}`:
 *  org/school bold, location top-right, role/degree italic, dates bottom-right. */
function subheading(a: string, b: string, c: string, d: string): string {
  return `    \\resumeSubheading\n      {${slot(a)}}{${slot(b)}}\n      {${slot(c)}}{${slot(d)}}`;
}

/** A bullet list, OMITTED entirely when the entry has no bullets — an empty
 *  itemize ("perhaps a missing \item") would abort the compile. */
function bulletList(entry: TailoredEntry): string {
  if (entry.bullets.length === 0) return "";
  const items = entry.bullets
    .map((bullet) => `        \\resumeItem{${slot(bullet.text)}}`)
    .join("\n");
  return `\n      \\resumeItemListStart\n${items}\n      \\resumeItemListEnd`;
}

/** Education dates: no "-- Present" (a degree in progress reads oddly that
 *  way); both -> "a -- b", one -> that one, neither -> "". */
function eduDates(start?: string, end?: string): string {
  if (start && end) return `${start} -- ${end}`;
  return start ?? end ?? "";
}

/**
 * The download filename slug, pinned at the HTTP header boundary (§3): role and
 * company are untrusted listing-derived text, so fold accents, lowercase, and
 * keep only [a-z0-9-] (repeats collapsed, ends trimmed, length-capped). An
 * all-hostile label yields the "resume" fallback.
 */
export function resumeFilenameSlug(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining marks so accents FOLD (café -> cafe), never split
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "resume";
}
