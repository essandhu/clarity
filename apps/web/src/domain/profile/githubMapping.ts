import type { ProjectEntry, RepoSummary } from "@/shared/schema";

// RepoSummary + languages -> ProjectEntry (PLAN-RESUME.md §4.6) — pure and
// VERBATIM (decision 45): description, topics, languages, stars and
// pushed-date are imported exactly as the API returned them; bullets are
// user-authored in the editor, so the import mints ZERO bullet text. Ids are
// minted through the injected seam (node:crypto never in domain, §4.4).

/** Languages folded into `technologies`, most-bytes-first. */
export const GITHUB_TOP_LANGUAGES = 5;

/** technologies item cap from ProjectEntrySchema (z.string().max(60)). */
const TECHNOLOGY_MAX_CHARS = 60;

export interface GithubMappingDeps {
  mintId(): string;
  /** Provenance stamp AND the ref's fetchedAt — the import moment. */
  importedAt: string;
}

export function repoToProjectEntry(
  repo: RepoSummary,
  languages: Record<string, number>,
  deps: GithubMappingDeps,
): ProjectEntry {
  const topLanguages = Object.entries(languages)
    .sort(([, aBytes], [, bBytes]) => bBytes - aBytes)
    .slice(0, GITHUB_TOP_LANGUAGES)
    .map(([language]) => language);

  // topics ∪ top languages, verbatim, case-insensitively deduped (a "rust"
  // topic beside the "Rust" language is one technology, not two). Items the
  // schema would reject (>60 chars) are dropped — technologies are chips,
  // and a clipped chip would no longer be verbatim.
  const seen = new Set<string>();
  const technologies: string[] = [];
  for (const item of [...repo.topics, ...topLanguages]) {
    const key = item.toLowerCase();
    if (item.length === 0 || item.length > TECHNOLOGY_MAX_CHARS || seen.has(key)) continue;
    seen.add(key);
    technologies.push(item);
  }

  return {
    id: deps.mintId(),
    name: repo.name,
    url: repo.htmlUrl,
    technologies,
    bullets: [],
    github: {
      fullName: repo.fullName,
      ...(repo.description !== undefined ? { description: repo.description } : {}),
      stars: repo.stars,
      pushedAt: repo.pushedAt,
      languages,
    },
    provenance: {
      origin: "github-api",
      ref: { url: repo.htmlUrl, label: repo.fullName, fetchedAt: deps.importedAt },
      importedAt: deps.importedAt,
    },
  };
}
