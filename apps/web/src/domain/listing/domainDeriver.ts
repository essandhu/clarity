// Company-domain derivation for Stage 1 (PLAN.md §4). Candidates are tried in
// priority order — the submitted listing URL's host, the fetch's final host
// (redirects), the applicationContact email's domain, then the model's own
// extraction — and the first one that is a plausible hostname AND survives the
// job-board denylist wins. An ATS/job-board host is NEVER the company domain,
// no matter which candidate produced it: qwen3-class models happily echo
// "greenhouse.io" into the domain field when the board URL appears in the text.

// Literal, curated denylist of hosts that can never be a company's own site:
// ATS hosts and job boards carry OTHER companies' listings, and freemail
// providers carry other people's mail. Matched by registrable suffix, so
// boards.greenhouse.io and acme.wd5.myworkdayjobs.com are covered.
// Deliberately excludes dual-use corporate domains (workday.com, rippling.com,
// sap.com) whose listing traffic lives on dedicated ATS hosts named here.
const NEVER_COMPANY_HOSTS = [
  // Applicant-tracking systems
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "myworkday.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "brassring.com",
  "oraclecloud.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
  "workable.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "bamboohr.com",
  "applytojob.com",
  "personio.com",
  "personio.de",
  "rippling-ats.com",
  "adp.com",
  "ultipro.com",
  "paylocity.com",
  "eightfold.ai",
  "avature.net",
  // Job boards / marketplaces
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "monster.com",
  "dice.com",
  "wellfound.com",
  "angel.co",
  "otta.com",
  "builtin.com",
  "simplyhired.com",
  "weworkremotely.com",
  "remoteok.com",
  // Freemail providers — a hiring@gmail.com contact must not make gmail.com
  // the "company domain" that increment 6 then enriches.
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
] as const;

// Two or more dot-separated labels ending in an alphabetic TLD — rejects bare
// words, IPs, and the model's occasional "n/a"-style noise.
const HOSTNAME_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

const EMAIL_DOMAIN = /@([a-z0-9.-]+\.[a-z]{2,})\b/gi;

export interface DomainCandidates {
  /** The URL the user submitted (URL input only). */
  listingUrl?: string;
  /** Where the fetch actually landed after redirects (URL input only). */
  finalUrl?: string;
  /** Model-extracted contact; an email's domain is a strong company signal. */
  applicationContact?: string;
  /** The model's own `domain` extraction from the listing text. */
  modelDomain?: string;
  /** The listing text itself — lowest-priority fallback (see below). */
  rawText?: string;
}

export function deriveDomain(candidates: DomainCandidates): string | undefined {
  const hosts = [
    hostOfUrl(candidates.listingUrl),
    hostOfUrl(candidates.finalUrl),
    // EVERY email in the contact text competes — a no-reply@greenhouse.io
    // must not mask a second, real company address further along.
    ...emailHosts(candidates.applicationContact),
    // The model may hand back anything from "acme.com" to a full URL.
    normalizeHost(candidates.modelDomain) ?? hostOfUrl(candidates.modelDomain),
    // Last resort: the ONE distinct non-denied URL host in the listing text.
    // qwen3:4b reproducibly omits `domain` even for an explicit "Company
    // website: https://…" line (live-observed 2026-07-06, increment 8); a
    // sole surviving host literally appears in the listing, so using it is
    // decision-16 clean — several distinct hosts stay ambiguous ⇒ absent.
    soleRawTextHost(candidates.rawText),
  ];
  return hosts.find((host) => host !== undefined && !isDeniedHost(host));
}

const RAW_TEXT_URL = /https?:\/\/[^\s<>"')\]]+/gi;

function soleRawTextHost(rawText: string | undefined): string | undefined {
  if (!rawText) return undefined;
  const hosts = new Set<string>();
  for (const match of rawText.match(RAW_TEXT_URL) ?? []) {
    const host = hostOfUrl(match);
    if (host !== undefined && !isDeniedHost(host)) hosts.add(host);
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

function isDeniedHost(host: string): boolean {
  return NEVER_COMPANY_HOSTS.some((denied) => host === denied || host.endsWith(`.${denied}`));
}

function emailHosts(contact: string | undefined): (string | undefined)[] {
  if (!contact) return [];
  return [...contact.matchAll(EMAIL_DOMAIN)].map((match) => normalizeHost(match[1]));
}

function hostOfUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return normalizeHost(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname);
  } catch {
    return undefined;
  }
}

function normalizeHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const host = raw.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return HOSTNAME_SHAPE.test(host) ? host : undefined;
}
