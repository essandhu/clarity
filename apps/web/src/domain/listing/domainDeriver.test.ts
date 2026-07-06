import { describe, expect, it } from "vitest";
import { deriveDomain } from "./domainDeriver";

describe("deriveDomain — job-board denylist (PLAN.md §7 increment 4)", () => {
  it.each([
    ["greenhouse", "https://boards.greenhouse.io/acme/jobs/4471023"],
    ["greenhouse (new host)", "https://job-boards.greenhouse.io/acme/jobs/4471023"],
    ["lever", "https://jobs.lever.co/acme/8f3c1d2e"],
    ["ashby", "https://jobs.ashbyhq.com/acme/0b1c"],
    ["workday", "https://acme.wd5.myworkdayjobs.com/en-US/External/job/R-12345"],
    ["taleo", "https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345"],
    ["successfactors", "https://career5.successfactors.com/career?company=acme"],
    ["brassring", "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=1"],
    ["oracle cloud", "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/12345"],
    ["linkedin", "https://www.linkedin.com/jobs/view/3712345678"],
    ["indeed", "https://www.indeed.com/viewjob?jk=abc123"],
  ])("never treats a %s host as the company domain", (_name, url) => {
    expect(deriveDomain({ listingUrl: url })).toBeUndefined();
  });

  it("never surfaces a freemail provider as the company domain", () => {
    expect(deriveDomain({ applicationContact: "hiring@gmail.com" })).toBeUndefined();
    expect(
      deriveDomain({ applicationContact: "jobs@outlook.com", modelDomain: "acme.dev" }),
    ).toBe("acme.dev");
  });

  it("scans ALL emails in the contact text, not just the first", () => {
    expect(
      deriveDomain({
        applicationContact: "no-reply@notifications.greenhouse.io or talent@acme.dev",
      }),
    ).toBe("acme.dev");
    expect(
      deriveDomain({ applicationContact: "personal me@gmail.com, work careers@acme.dev" }),
    ).toBe("acme.dev");
  });

  it("suffix-matches the denylist without swallowing lookalike domains", () => {
    // Denied: exact host and any subdomain of a denylisted entry.
    expect(deriveDomain({ modelDomain: "greenhouse.io" })).toBeUndefined();
    expect(deriveDomain({ modelDomain: "deep.sub.greenhouse.io" })).toBeUndefined();
    // Allowed: names that merely contain a denylisted string.
    expect(deriveDomain({ modelDomain: "mygreenhouse.io" })).toBe("mygreenhouse.io");
    expect(deriveDomain({ modelDomain: "lever.company" })).toBe("lever.company");
  });

  it("applies the denylist to EVERY candidate, including email and model output", () => {
    expect(
      deriveDomain({
        listingUrl: "https://boards.greenhouse.io/acme/jobs/1",
        applicationContact: "recruiting@notifications.greenhouse.io",
        modelDomain: "greenhouse.io",
      }),
    ).toBeUndefined();
  });
});

describe("deriveDomain — candidate priority", () => {
  it("prefers a company-owned listing URL host, stripping www", () => {
    expect(
      deriveDomain({
        listingUrl: "https://www.acme.dev/careers/platform-engineer",
        applicationContact: "talent@other.example",
        modelDomain: "elsewhere.example",
      }),
    ).toBe("acme.dev");
  });

  it("falls back past a job-board URL to the final redirect host", () => {
    expect(
      deriveDomain({
        listingUrl: "https://jobs.lever.co/acme/1",
        finalUrl: "https://careers.acme.dev/roles/1",
      }),
    ).toBe("careers.acme.dev");
  });

  it("falls back to the applicationContact email domain", () => {
    expect(
      deriveDomain({
        listingUrl: "https://boards.greenhouse.io/acme/jobs/1",
        applicationContact: "talent@acme.dev",
      }),
    ).toBe("acme.dev");
  });

  it("extracts the email domain out of surrounding contact text", () => {
    expect(
      deriveDomain({ applicationContact: "Alex Rivera (alex@driftlock.io), Head of Eng" }),
    ).toBe("driftlock.io");
  });

  it("falls back to the model's extraction last", () => {
    expect(
      deriveDomain({
        listingUrl: "https://jobs.ashbyhq.com/acme/1",
        applicationContact: "Reach out to Sam on the careers page",
        modelDomain: "acme.dev",
      }),
    ).toBe("acme.dev");
  });

  it("returns undefined when no candidate survives", () => {
    expect(deriveDomain({})).toBeUndefined();
    expect(
      deriveDomain({ applicationContact: "apply via the portal", modelDomain: "not a domain" }),
    ).toBeUndefined();
  });

  it("falls back to the ONE distinct non-denied URL host in the listing text", () => {
    // qwen3:4b reproducibly omits `domain` even for an explicit "Company
    // website: https://…" line (live-observed 2026-07-06, increment 8) — a
    // sole surviving rawText host literally appears in the listing, so
    // using it invents nothing.
    expect(
      deriveDomain({
        rawText:
          "Company website: https://driftlock.io\nMore at https://www.driftlock.io/about.",
      }),
    ).toBe("driftlock.io");
    // A denied host never breaks uniqueness — it is categorically not a
    // company domain.
    expect(
      deriveDomain({
        rawText: "Apply at https://boards.greenhouse.io/acme — we are https://acme.dev",
      }),
    ).toBe("acme.dev");
  });

  it("keeps domain absent when the text offers several distinct hosts — picking one would be a guess", () => {
    expect(
      deriveDomain({
        rawText: "See https://acme.dev and our partner https://widgets.example",
      }),
    ).toBeUndefined();
    expect(deriveDomain({ rawText: "no urls here at all" })).toBeUndefined();
  });

  it("ranks the rawText host LAST — every explicit signal wins over it", () => {
    expect(
      deriveDomain({ modelDomain: "acme.dev", rawText: "Visit https://other.example" }),
    ).toBe("acme.dev");
  });
});

describe("deriveDomain — normalization", () => {
  it("normalizes model output handed back as a URL or with junk", () => {
    expect(deriveDomain({ modelDomain: "https://www.acme.dev/about" })).toBe("acme.dev");
    expect(deriveDomain({ modelDomain: "  WWW.Acme.DEV.  " })).toBe("acme.dev");
    expect(deriveDomain({ modelDomain: "acme.dev/careers" })).toBe("acme.dev");
  });

  it("rejects bare words, IPs, and empty strings", () => {
    expect(deriveDomain({ modelDomain: "acme" })).toBeUndefined();
    expect(deriveDomain({ modelDomain: "192.168.0.1" })).toBeUndefined();
    expect(deriveDomain({ modelDomain: "" })).toBeUndefined();
    expect(deriveDomain({ modelDomain: "n/a" })).toBeUndefined();
  });

  it("is case-insensitive against the denylist", () => {
    expect(deriveDomain({ modelDomain: "Boards.Greenhouse.IO" })).toBeUndefined();
  });
});
