import { describe, expect, it } from "vitest";
import { pastedRef, webRef } from "@/domain/synthesis/synthesisTestKit";
import {
  groundPeople,
  isPublicFinalPage,
  linkedInSearchUrl,
  listingCandidate,
  MAX_CONTACT_PEOPLE,
  pickCareersRef,
} from "./contactCandidates";
import { coverageOf } from "./contactTestKit";

describe("groundPeople", () => {
  const excerpts = [
    { ref: pastedRef, text: "listing text" },
    { ref: webRef("https://acme.dev/careers"), text: "careers text" },
  ];

  it("maps verbatim sourceUrls back to held refs and drops fabricated attributions", () => {
    const people = groundPeople(
      [
        { name: "Jane Doe", sourceUrl: "listing:pasted" },
        { name: "Sam Lee", role: "Recruiter", sourceUrl: "https://acme.dev/careers/" },
        { name: "Made Up", sourceUrl: "https://elsewhere.example/team" },
      ],
      excerpts,
    );
    expect(people.map((p) => p.name)).toEqual(["Jane Doe", "Sam Lee"]);
    expect(people[0].ref).toBe(pastedRef);
    expect(people[1].role).toBe("Recruiter");
  });

  it("dedupes by name case-insensitively and caps at MAX_CONTACT_PEOPLE", () => {
    const raw = ["Jane Doe", "jane doe", "Sam Lee", "Ana Ruiz", "Extra Person"].map((name) => ({
      name,
      sourceUrl: "listing:pasted",
    }));
    const people = groundPeople(raw, excerpts);
    expect(people).toHaveLength(MAX_CONTACT_PEOPLE);
    expect(people.map((p) => p.name)).toEqual(["Jane Doe", "Sam Lee", "Ana Ruiz"]);
  });

  it("refuses an email address posing as a person name", () => {
    expect(groundPeople([{ name: "jobs@acme.dev", sourceUrl: "listing:pasted" }], excerpts)).toEqual(
      [],
    );
  });

  it("keeps a person email ONLY when it literally appears in a held excerpt text", () => {
    const withEmail = [
      { ref: pastedRef, text: "Reach Sam Lee at SAM.LEE@acme.dev for questions." },
    ];
    const grounded = groundPeople(
      [{ name: "Sam Lee", email: "sam.lee@acme.dev", sourceUrl: "listing:pasted" }],
      withEmail,
    );
    expect(grounded[0].email).toBe("sam.lee@acme.dev");
    // Same person, same claim — but the sources never publish the address:
    // a model-invented email must not survive into a 'public' candidate.
    const hallucinated = groundPeople(
      [{ name: "Sam Lee", email: "sam.lee@acme.dev", sourceUrl: "listing:pasted" }],
      [{ ref: pastedRef, text: "Reach Sam Lee, Head of Talent, for questions." }],
    );
    expect(hallucinated[0].email).toBeUndefined();
  });
});

describe("listingCandidate", () => {
  const noEmailText = "We are hiring. Apply through our site.";

  it("splits an email out of the contact text, keeping the rest as the name", () => {
    expect(listingCandidate("Jane Doe <jane@acme.dev>", noEmailText, pastedRef)).toMatchObject({
      channel: "listing",
      confidence: "public",
      name: "Jane Doe",
      value: "jane@acme.dev",
    });
  });

  it("keeps a bare email as the value with no invented name", () => {
    expect(listingCandidate("recruiting@acme.dev", noEmailText, pastedRef)).toMatchObject({
      name: undefined,
      value: "recruiting@acme.dev",
    });
  });

  it("keeps a bare name as the name with no invented value", () => {
    expect(listingCandidate("Jane Doe, Recruiting Lead", noEmailText, pastedRef)).toMatchObject({
      name: "Jane Doe, Recruiting Lead",
      value: undefined,
    });
  });

  it("keeps an application URL as the value", () => {
    expect(listingCandidate("https://acme.dev/apply", noEmailText, pastedRef)).toMatchObject({
      value: "https://acme.dev/apply",
      name: undefined,
    });
  });

  it("recovers a model-garbled address from the listing text's one published email", () => {
    // Live-observed Stage-1 artifact: qwen3:4b emitted "recruiting@dr:driftlock.io".
    expect(
      listingCandidate(
        "recruiting@dr:driftlock.io",
        "Questions? Email recruiting@driftlock.io and we'll reply.",
        pastedRef,
      ),
    ).toMatchObject({ name: undefined, value: "recruiting@driftlock.io", confidence: "public" });
  });

  it("pairs a named-but-addressless contact with the text's one published email", () => {
    expect(
      listingCandidate("Jane Doe", "Send questions to jane.doe@acme.dev.", pastedRef),
    ).toMatchObject({ name: "Jane Doe", value: "jane.doe@acme.dev" });
  });

  it("surfaces the text's one published email even without an applicationContact", () => {
    expect(listingCandidate(undefined, "Reach us: hello@acme.dev", pastedRef)).toMatchObject({
      name: undefined,
      value: "hello@acme.dev",
    });
  });

  it("never falls back when the text publishes several distinct emails — picking one would be a guess", () => {
    expect(
      listingCandidate(undefined, "hello@acme.dev or press@acme.dev", pastedRef),
    ).toBeUndefined();
    expect(listingCandidate(undefined, noEmailText, pastedRef)).toBeUndefined();
  });

  it("treats repeats of the same address as one published email", () => {
    expect(
      listingCandidate(undefined, "Email HELLO@acme.dev — that's hello@acme.dev.", pastedRef),
    ).toMatchObject({ value: "HELLO@acme.dev" });
  });
});

describe("pickCareersRef", () => {
  it("prefers tier 1 careers-ish paths and careers-ish hosts", () => {
    const careers = webRef("https://acme.dev/careers");
    expect(pickCareersRef(coverageOf({ 1: [webRef("https://acme.dev"), careers] }))).toBe(careers);
    const hostRef = webRef("https://jobs.acme.dev/openings");
    expect(pickCareersRef(coverageOf({ 1: [hostRef] }))).toBe(hostRef);
  });

  it("never picks the pasted-listing sentinel or a github source", () => {
    expect(
      pickCareersRef(coverageOf({ 0: [pastedRef], 2: [webRef("https://github.com/acme")] })),
    ).toBeUndefined();
  });

  it("never picks a private/intranet host — coverage is client-supplied", () => {
    const publicRef = webRef("https://acme.dev/jobs");
    expect(pickCareersRef(coverageOf({ 1: [webRef("https://it.corp/careers")] }))).toBeUndefined();
    expect(
      pickCareersRef(coverageOf({ 1: [webRef("https://it.corp/careers"), publicRef] })),
    ).toBe(publicRef);
  });

  it("matches whole path segments only — jobs-the-person and joint-ventures are not careers pages", () => {
    expect(
      pickCareersRef(
        coverageOf({
          1: [
            webRef("https://acme.dev/blog/steve-jobs-tribute"),
            webRef("https://acme.dev/joint-venture"),
            webRef("https://acme.dev/blog/2025-hiring-freeze"),
          ],
        }),
      ),
    ).toBeUndefined();
    const nested = webRef("https://acme.dev/careers/london");
    expect(pickCareersRef(coverageOf({ 1: [nested] }))).toBe(nested);
  });
});

describe("isPublicFinalPage", () => {
  it("refuses redirect targets on private hosts and non-http schemes", () => {
    expect(isPublicFinalPage("https://acme.dev/careers")).toBe(true);
    expect(isPublicFinalPage("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isPublicFinalPage("https://it.corp/admin")).toBe(false);
    expect(isPublicFinalPage("file:///etc/passwd")).toBe(false);
    expect(isPublicFinalPage("not a url")).toBe(false);
  });
});

describe("linkedInSearchUrl", () => {
  it("URL-encodes the person and company into a people-search link", () => {
    expect(linkedInSearchUrl("Jane Doe", "Acme & Co")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=Jane%20Doe%20Acme%20%26%20Co",
    );
  });
});
