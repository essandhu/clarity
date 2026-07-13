import type { MasterProfile, ProjectEntry, TailorSelection } from "@/shared/schema";
import type { TailorAliasContext } from "./tailorPrompt";

// Decision 40: a failed selection call never kills a tailor run — this pure,
// model-free recency selection feeds the SAME resolve fold, emitted with an
// honest coverage.mode 'fallback-untailored'. It speaks the prompt's alias
// space (the fold's one id space), selecting only OFFERED entries: what the
// model could not pick, the fallback does not pick either.

const FALLBACK_EXPERIENCE = 3; // most-recent (master order) experience entries
const FALLBACK_BULLETS = 2; // first bullets of each
const FALLBACK_PROJECTS = 2; // by pushedAt when every project carries one

/** TailoredResumeSchema.skills max — "all skill groups" clamps here so the
 *  fallback can never zod-fail the terminal frame (master allows 10). */
const FALLBACK_SKILL_GROUPS = 6;

export function fallbackSelection(
  master: MasterProfile,
  ctx: TailorAliasContext,
): TailorSelection {
  const offered = [...ctx.aliases.values()];
  const experience = offered
    .filter((aliased) => aliased.kind === "experience")
    .slice(0, FALLBACK_EXPERIENCE);

  const projects = offered.filter((aliased) => aliased.kind === "project");
  // "any missing sort key ⇒ master order": pushedAt orders the picks only
  // when EVERY offered project carries one (github imports do).
  const everyPushed = projects.every(
    (aliased) => (aliased.entry as ProjectEntry).github?.pushedAt !== undefined,
  );
  const orderedProjects = everyPushed
    ? [...projects].sort((a, b) =>
        ((b.entry as ProjectEntry).github?.pushedAt ?? "").localeCompare(
          (a.entry as ProjectEntry).github?.pushedAt ?? "",
        ),
      )
    : projects;

  return {
    entries: [...experience, ...orderedProjects.slice(0, FALLBACK_PROJECTS)].map((aliased) => ({
      entryId: aliased.alias,
      bulletIds: [...aliased.bullets.keys()].slice(0, FALLBACK_BULLETS),
      // No rephrased array: all-verbatim dispositions (decision 38's shape).
    })),
    skills: master.skills.slice(0, FALLBACK_SKILL_GROUPS).map((group) => ({
      category: group.category,
      items: [...group.items],
    })),
  };
}
