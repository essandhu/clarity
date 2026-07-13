import { describe, expect, it } from "vitest";
import { ProjectEntrySchema, type RepoSummary } from "@/shared/schema";
import { repoToProjectEntry } from "./githubMapping";

// Decision 45: the mapping is VERBATIM and README-free — description,
// topics, languages, stars, pushed-date exactly as the API returned them,
// zero bullets (user-authored later), provenance citing html_url.

const repo: RepoSummary = {
  fullName: "octocat/clarity",
  name: "clarity",
  description: "A local-first research tool",
  topics: ["nextjs", "research"],
  stars: 12,
  pushedAt: "2026-06-01T12:00:00Z",
  fork: false,
  archived: false,
  htmlUrl: "https://github.com/octocat/clarity",
};

const deps = { mintId: () => "id-1", importedAt: "2026-07-12T10:00:00.000Z" };

describe("repoToProjectEntry", () => {
  it("maps verbatim with zero bullets and an html_url provenance ref", () => {
    const entry = repoToProjectEntry(repo, { TypeScript: 900, CSS: 100 }, deps);
    expect(ProjectEntrySchema.parse(entry)).toBeTruthy();
    expect(entry).toMatchObject({
      name: "clarity",
      url: "https://github.com/octocat/clarity",
      bullets: [],
      github: {
        fullName: "octocat/clarity",
        description: "A local-first research tool", // decision 45: verbatim
        stars: 12,
        pushedAt: "2026-06-01T12:00:00Z",
        languages: { TypeScript: 900, CSS: 100 },
      },
      provenance: {
        origin: "github-api",
        ref: {
          url: "https://github.com/octocat/clarity",
          label: "octocat/clarity",
          fetchedAt: deps.importedAt,
        },
        importedAt: deps.importedAt,
      },
    });
  });

  it("technologies = topics ∪ top 5 languages by bytes, case-insensitively deduped", () => {
    const entry = repoToProjectEntry(
      { ...repo, topics: ["typescript", "research"] },
      { TypeScript: 900, CSS: 100, Go: 50, Rust: 40, Python: 30, Shell: 20, HTML: 10 },
      deps,
    );
    // "typescript" topic absorbs the TypeScript language; Shell/HTML fall
    // past the top-5 cut (CSS, Go, Rust, Python fill it after TypeScript).
    expect(entry.technologies).toEqual(["typescript", "research", "CSS", "Go", "Rust", "Python"]);
  });

  it("drops technologies the schema would reject instead of clipping them", () => {
    const long = "x".repeat(61);
    const entry = repoToProjectEntry({ ...repo, topics: [long, "ok"] }, {}, deps);
    expect(entry.technologies).toEqual(["ok"]);
  });
});
