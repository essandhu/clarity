import { describe, expect, it } from "vitest";
import { makeProfile, webRef } from "@/domain/synthesis/synthesisTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { pageSourceRef } from "@/shared/schema";
import { findGithubContact, githubOrgRef, isEngineeringRole } from "./githubSignal";
import { contactBudget, coverageOf, makePage, spentBudget } from "./contactTestKit";

const ORG_URL = "https://github.com/acme";
const orgCoverage = coverageOf({ 2: [webRef(ORG_URL)] });

describe("isEngineeringRole", () => {
  it("matches engineering-shaped titles", () => {
    expect(isEngineeringRole(makeProfile())).toBe(true); // "Backend Engineer"
    expect(isEngineeringRole(makeProfile({ role: "Staff Developer" }))).toBe(true);
    expect(isEngineeringRole(makeProfile({ role: "Data Scientist" }))).toBe(true);
  });

  it("rejects non-engineering roles — generic tokens and tool mentions do not qualify", () => {
    expect(isEngineeringRole(makeProfile({ role: "Account Executive" }))).toBe(false);
    // Review finding: bare \bdata\b matched "Data Entry Clerk", and any
    // listing naming a SaaS tool passed via the namedTechnologies catch-all.
    expect(isEngineeringRole(makeProfile({ role: "Data Entry Clerk" }))).toBe(false);
    expect(
      isEngineeringRole(
        makeProfile({ role: "Recruiting Coordinator", namedTechnologies: ["Greenhouse"] }),
      ),
    ).toBe(false);
  });
});

describe("githubOrgRef", () => {
  it("finds a github.com source in any tier, ignoring the pasted sentinel", () => {
    const ref = webRef("https://www.github.com/acme");
    expect(githubOrgRef(coverageOf({ 2: [ref] }))?.url).toBe("https://github.com/acme");
    expect(githubOrgRef(coverageOf({ 1: [webRef("https://acme.dev")] }))).toBeUndefined();
  });

  it("normalizes any github path to the OWNER page — a repo/commit ref cannot widen the scope", () => {
    const repo = webRef("https://github.com/acme/widget/commits/main");
    expect(githubOrgRef(coverageOf({ 2: [repo] }))?.url).toBe("https://github.com/acme");
  });

  it("refuses github product pages — /pricing is not an org", () => {
    expect(
      githubOrgRef(coverageOf({ 2: [webRef("https://github.com/pricing")] })),
    ).toBeUndefined();
  });
});

describe("pageSourceRef (shared schema factory)", () => {
  it("clips the attacker-controlled title and falls back to host+path", () => {
    const long = makePage(ORG_URL, "text", "T".repeat(500));
    expect(pageSourceRef(long).label).toHaveLength(200);
    const untitled = makePage(ORG_URL, "text", "  ");
    expect(pageSourceRef(untitled).label).toBe("github.com/acme");
  });
});

describe("findGithubContact", () => {
  const profile = makeProfile();

  it("reports none — with zero fetches — when the run never cited an org page", async () => {
    const fetcher = new FakePageFetcher();
    const result = await findGithubContact(profile, coverageOf({}), {
      fetcher,
      budget: contactBudget(),
    });
    expect(result).toEqual({ tried: { id: "github", status: "none" } });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("surfaces a published org-page email as a public candidate", async () => {
    const fetcher = new FakePageFetcher({
      [ORG_URL]: makePage(ORG_URL, "Acme Robotics build tools. Contact oss@acme.dev."),
    });
    const { candidate, tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(tried).toEqual({ id: "github", status: "found" });
    expect(candidate).toMatchObject({
      channel: "github",
      confidence: "public",
      value: "oss@acme.dev",
      source: { url: ORG_URL },
    });
  });

  it("reports none when the org page never mentions the company (wrong-org rule)", async () => {
    const fetcher = new FakePageFetcher({
      [ORG_URL]: makePage(ORG_URL, "Someone else entirely. mail@stranger.example", "acme · GitHub"),
    });
    const { candidate, tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(candidate).toBeUndefined();
    expect(tried).toEqual({ id: "github", status: "none" });
  });

  it("reports none when the page matches but publishes no email — nothing is inferred here", async () => {
    const fetcher = new FakePageFetcher({
      [ORG_URL]: makePage(ORG_URL, "Acme Robotics builds robots for warehouses."),
    });
    const { candidate, tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(candidate).toBeUndefined();
    expect(tried).toEqual({ id: "github", status: "none" });
  });

  it("reports a skipped fetch honestly", async () => {
    const fetcher = new FakePageFetcher({
      [ORG_URL]: { kind: "skip", url: ORG_URL, reason: "robots_disallowed" },
    });
    const { tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(tried).toMatchObject({
      id: "github",
      status: "skipped",
      skip: { reason: "robots_disallowed" },
    });
  });

  it("skips as budget_exhausted with zero network when the contact budget is spent", async () => {
    const fetcher = new FakePageFetcher();
    const { tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: spentBudget(),
    });
    expect(tried).toMatchObject({ id: "github", status: "skipped", skip: { reason: "budget_exhausted" } });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("refuses content when the fetch redirected off github.com (final host decides)", async () => {
    const offsite = makePage(ORG_URL, "Acme Robotics. Contact oss@acme.dev.");
    const fetcher = new FakePageFetcher({
      [ORG_URL]: { ...offsite, finalUrl: "https://evil.example/acme" },
    });
    const { candidate, tried } = await findGithubContact(profile, orgCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(candidate).toBeUndefined();
    expect(tried).toMatchObject({
      id: "github",
      status: "skipped",
      skip: { reason: "empty_content", detail: expect.stringContaining("redirected off github.com") },
    });
  });

  it("fetches the NORMALIZED org page when coverage cites a repo path", async () => {
    const repoCoverage = coverageOf({ 2: [webRef("https://github.com/acme/widget")] });
    const fetcher = new FakePageFetcher({
      [ORG_URL]: makePage(ORG_URL, "Acme Robotics build tools. Contact oss@acme.dev."),
    });
    const { candidate } = await findGithubContact(profile, repoCoverage, {
      fetcher,
      budget: contactBudget(),
    });
    expect(fetcher.calls.map((call) => call.url)).toEqual([ORG_URL]);
    expect(candidate).toMatchObject({ channel: "github", value: "oss@acme.dev" });
  });
});
