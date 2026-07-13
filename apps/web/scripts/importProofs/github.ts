// The §7.12 GitHub live proof: keyless stage A costs exactly 2 quota units
// (proven by bracketing with the quota-free /rate_limit endpoint from the
// same IP), stage B exactly one per imported repo, imported fields byte-
// match the RAW API responses (verbatim proof), every entry cites its
// html_url, and the immediate warm re-run is served from data/github/ with
// ZERO quota spent.
import { readdirSync, rmSync } from "node:fs";
import {
  GithubReposResponseSchema,
  ImportedEntriesSchema,
  ImportReportSchema,
  type GithubReposResponse,
} from "../../src/shared/schema";
import { at, check, finish } from "./harness";

const DRIVER_UA = "clarity-try-import-driver";

interface RawRepo {
  name: string;
  description: string | null;
  topics?: string[];
  html_url: string;
  stargazers_count: number;
}

async function rateRemaining(): Promise<number> {
  const res = await fetch("https://api.github.com/rate_limit", {
    headers: { "User-Agent": DRIVER_UA, Accept: "application/vnd.github+json" },
  });
  const body = (await res.json()) as { resources: { core: { remaining: number } } };
  return body.resources.core.remaining;
}

export async function runGithubProof(username: string, base: string): Promise<void> {
  // Cold-start the server-side cache so the quota accounting below measures
  // THIS run (the driver runs beside the server; data/github is its disk).
  rmSync("data/github", { recursive: true, force: true });
  console.log(`[${at()}] cleared data/github for a cold stage A`);

  const r0 = await rateRemaining();
  const reposRes = await fetch(`${base}/api/profile/import/github/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  check("stage A returned 200", reposRes.status === 200, `status=${reposRes.status}`);
  const listedParse = GithubReposResponseSchema.safeParse(await reposRes.json());
  check("stage A response is zod-valid", listedParse.success, listedParse.success ? undefined : listedParse.error.issues[0]?.message);
  if (!listedParse.success) return finish();
  const listed: GithubReposResponse = listedParse.data;
  const r1 = await rateRemaining();
  console.log(
    `[${at()}] listed ${listed.repos.length} repos order=${listed.order} rate=${listed.rate.remaining}/${listed.rate.limit} quotaSpent=${r0 - r1}`,
  );
  check("stage A spent exactly 2 quota-bearing requests", r0 - r1 === 2, `delta=${r0 - r1}`);
  check("keyless order is labeled 'stars' honestly", listed.order === "stars", listed.order);
  const starsSorted = listed.repos.every(
    (repo, i) => i === 0 || (listed.repos[i - 1]?.stars ?? 0) >= repo.stars,
  );
  check("repo list is stars-descending", starsSorted);

  const picked = listed.repos.slice(0, 3).map((repo) => repo.name);
  if (picked.length < 3) {
    check("user has at least 3 repos to import", false, `${picked.length} available`);
    return finish();
  }

  // The driver's OWN raw read of the same API — the byte-match reference.
  // (Spends 1 driver-side quota unit, deliberately OUTSIDE the brackets.)
  const rawRes = await fetch(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`,
    { headers: { "User-Agent": DRIVER_UA, Accept: "application/vnd.github+json" } },
  );
  const rawByName = new Map(
    ((await rawRes.json()) as RawRepo[]).map((repo) => [repo.name, repo]),
  );

  const r2 = await rateRemaining();
  const importRes = await fetch(`${base}/api/profile/import/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, repos: picked }),
  });
  check("stage B returned 200", importRes.status === 200, `status=${importRes.status}`);
  const importBody = (await importRes.json()) as { entries: unknown; report: unknown };
  const entriesParse = ImportedEntriesSchema.safeParse(importBody.entries);
  const reportParse = ImportReportSchema.safeParse(importBody.report);
  check("stage B entries + report are zod-valid", entriesParse.success && reportParse.success);
  if (!entriesParse.success || !reportParse.success) return finish();
  const r3 = await rateRemaining();
  check(
    "stage B spent exactly one request per imported repo (serial /languages)",
    r2 - r3 === picked.length,
    `delta=${r2 - r3}`,
  );

  const projects = entriesParse.data.projects;
  check("3 ticked repos imported as 3 project entries", projects.length === 3, `${projects.length}`);
  const mismatches: string[] = [];
  for (const project of projects) {
    const raw = rawByName.get(project.name);
    if (!raw) {
      mismatches.push(`${project.name}: not in the driver's raw list`);
      continue;
    }
    const rawDescription = raw.description ?? undefined;
    if (project.github?.description !== rawDescription) {
      mismatches.push(`${project.name}: description mismatch`);
    }
    for (const topic of raw.topics ?? []) {
      if (!project.technologies.includes(topic)) {
        mismatches.push(`${project.name}: topic "${topic}" missing from technologies`);
      }
    }
    if (project.url !== raw.html_url) mismatches.push(`${project.name}: url mismatch`);
    if (project.provenance.ref?.url !== raw.html_url || project.provenance.origin !== "github-api") {
      mismatches.push(`${project.name}: provenance ref is not the html_url`);
    }
    if (project.bullets.length !== 0) mismatches.push(`${project.name}: bullets were invented`);
  }
  check("descriptions/topics byte-match the RAW API responses (verbatim proof)", mismatches.length === 0, mismatches.slice(0, 4).join("; ") || undefined);
  check("report carries no quota-skip notes on this run", reportParse.data.notes.length === 0, reportParse.data.notes.join(" | ") || undefined);

  // Warm re-run: both stages again, bracketed — served from data/github/.
  const r4 = await rateRemaining();
  const warmList = await fetch(`${base}/api/profile/import/github/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const warmListBody = GithubReposResponseSchema.safeParse(await warmList.json());
  const warmImport = await fetch(`${base}/api/profile/import/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, repos: picked }),
  });
  const warmBody = (await warmImport.json()) as { entries: unknown };
  const warmEntries = ImportedEntriesSchema.safeParse(warmBody.entries);
  const r5 = await rateRemaining();
  check("warm re-run (both stages) spent ZERO quota — served from data/github/", r4 - r5 === 0, `delta=${r4 - r5}`);
  check("warm stage A still zod-valid with rate info (free /rate_limit)", warmListBody.success);
  check(
    "warm import returns the same repos",
    warmEntries.success &&
      JSON.stringify(warmEntries.data.projects.map((p) => p.name)) === JSON.stringify(picked),
  );

  const cacheFiles = readdirSync("data/github").filter((name) => name.endsWith(".json"));
  check("data/github/ is populated on disk", cacheFiles.length > 0, `${cacheFiles.length} records`);
  finish();
}
