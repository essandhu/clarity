import type {
  ExperienceEntry,
  ListingProfile,
  MasterProfile,
  ProjectEntry,
} from "@/shared/schema";

// Shared fixtures for the tailor test files (the extractorTestKit /
// synthesisTestKit precedent — typed against schemas only; the stub model
// re-exported from the listing kit keeps ONE scripted-extract shape).
export { stubModel } from "@/domain/listing/extractorTestKit";

const PROVENANCE = { origin: "manual" as const, importedAt: "2026-07-12T00:00:00.000Z" };

/** Mirrors fixtures/resume/master-profile.json in miniature — deliberately
 *  kubernetes-free (the hostile-role proofs depend on it). */
export function makeMaster(overrides: Partial<MasterProfile> = {}): MasterProfile {
  return {
    version: 1,
    identity: {
      name: "Maya Chen",
      email: "maya.chen@example.com",
      links: [{ label: "GitHub", url: "https://github.com/mayachen" }],
    },
    experience: [
      makeExperience(),
      makeExperience({
        id: "exp-acme",
        org: "Acme Analytics",
        role: "Software Engineer",
        startDate: "Jun 2018",
        endDate: "Dec 2021",
        bullets: [
          { id: "b-billing", text: "Shipped the billing reconciliation service in TypeScript" },
          { id: "b-ci", text: "Reduced CI wall-clock time from 40 minutes to 9" },
        ],
      }),
    ],
    projects: [makeProject()],
    education: [
      {
        id: "edu-lisbon",
        school: "University of Lisbon",
        degree: "BSc Computer Science",
        startDate: "2014",
        endDate: "2018",
        provenance: PROVENANCE,
      },
    ],
    skills: [
      { id: "sk-lang", category: "Languages", items: ["Go", "TypeScript", "Python", "SQL"] },
      { id: "sk-infra", category: "Infrastructure", items: ["Postgres", "Kafka", "Docker"] },
    ],
    updatedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeExperience(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "exp-driftlock",
    org: "Driftlock",
    role: "Senior Software Engineer",
    location: "Lisbon, Portugal",
    startDate: "Jan 2022",
    bullets: [
      {
        id: "b-ingest",
        text: "Rebuilt the event ingestion pipeline in Go, cutting p99 latency from 900ms to 120ms",
      },
      {
        id: "b-migration",
        text: "Led the migration of 14 services from a shared Postgres cluster to per-service databases",
      },
      {
        id: "b-mentoring",
        text: "Mentored four engineers through the platform team's on-call rotation redesign",
      },
    ],
    provenance: PROVENANCE,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj-driftviz",
    name: "driftviz",
    url: "https://github.com/mayachen/driftviz",
    technologies: ["TypeScript", "D3", "WebGL"],
    bullets: [{ id: "b-render", text: "Renders one million points at 60fps in the browser" }],
    provenance: PROVENANCE,
    ...overrides,
  };
}

export function makeRole(overrides: Partial<ListingProfile> = {}): ListingProfile {
  return {
    company: "Tessellate",
    role: "Platform Engineer",
    namedTechnologies: ["Go", "Kubernetes", "AWS"],
    rawText:
      "Tessellate is hiring a Platform Engineer to own our ingestion services. " +
      "Stack: Go, Kubernetes, AWS. You will migrate services and mentor engineers.",
    ...overrides,
  };
}
