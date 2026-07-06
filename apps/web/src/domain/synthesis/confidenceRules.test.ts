import { describe, expect, it } from "vitest";
import { SECTION_PLAN, type SectionId } from "@/shared/schema";
import { planSections, type PlannedSection } from "./confidenceRules";
import { MAX_SECTION_WEB_SOURCES, SECTION_EXCERPT_CAP } from "./sectionSources";
import { makeEnrichment, makeProfile, pastedRef, webRef } from "./synthesisTestKit";

const byId = (planned: PlannedSection[]) =>
  Object.fromEntries(planned.map((p) => [p.id, p])) as Record<SectionId, PlannedSection>;

describe("planSections — sparse paste path (listing is the only source)", () => {
  // The §7 sparse-startup scenario: no domain, nothing optional extracted.
  const plan = byId(planSections(makeProfile(), makeEnrichment()));

  it("emits the full fixed plan in SECTION_PLAN order", () => {
    expect(planSections(makeProfile(), makeEnrichment()).map((p) => p.id)).toEqual([
      ...SECTION_PLAN,
    ]);
  });

  it("what-they-do and seniority-fit are low and cite the pasted listing ref", () => {
    for (const id of ["what-they-do", "seniority-fit"] as const) {
      expect(plan[id].confidence).toBe("low");
      expect(plan[id].sources).toEqual([pastedRef]);
      expect(plan[id].excerpts).toHaveLength(1);
      expect(plan[id].excerpts[0].text).toContain("Acme Robotics");
    }
  });

  it("sections without listing material are none with NO sources or excerpts", () => {
    for (const id of ["product-area", "stack", "team-signals", "recent-launches"] as const) {
      expect(plan[id].confidence).toBe("none");
      expect(plan[id].sources).toEqual([]);
      expect(plan[id].excerpts).toEqual([]);
    }
  });

  it("extracted optionals flip their sections to low, still citing the listing", () => {
    const rich = byId(
      planSections(
        makeProfile({
          productArea: "warehouse robotics",
          teamSignals: "team of six",
          namedTechnologies: ["Go"],
        }),
        makeEnrichment(),
      ),
    );
    for (const id of ["product-area", "stack", "team-signals"] as const) {
      expect(rich[id].confidence).toBe("low");
      expect(rich[id].sources).toEqual([pastedRef]);
    }
    // Recency can never come from a listing snapshot.
    expect(rich["recent-launches"].confidence).toBe("none");
  });

  it("low sections on the URL path cite the real fetched listing ref", () => {
    const listingRef = webRef("https://jobs.acme.dev/roles/42", "Backend Engineer — Acme");
    const plan2 = byId(
      planSections(
        makeProfile(),
        makeEnrichment({ listing: { ref: listingRef, text: "Acme hires a backend engineer." } }),
      ),
    );
    expect(plan2["what-they-do"].confidence).toBe("low");
    expect(plan2["what-they-do"].sources).toEqual([listingRef]);
  });
});

describe("planSections — web coverage promotes sections to high", () => {
  const home = { ref: webRef("https://acme.dev/", "Acme"), text: "Acme builds robots." };
  const about = { ref: webRef("https://acme.dev/about", "About"), text: "Founded in 2020." };
  const careers = { ref: webRef("https://acme.dev/careers", "Careers"), text: "We use Go and Postgres." };
  const github = { ref: webRef("https://github.com/acme", "acme · GitHub"), text: "Repos in Go." };
  const blog = { ref: webRef("https://acme.dev/blog", "Blog"), text: "Shipping updates." };
  const changelog = { ref: webRef("https://acme.dev/changelog", "Changelog"), text: "v2 shipped in June." };
  const news = { ref: webRef("https://press.example/acme-round", "Acme raises"), text: "Acme raised a round." };

  it("what-they-do is high, ranked homepage-first (capped), and still cites the listing last", () => {
    const plan = byId(
      planSections(makeProfile(), makeEnrichment({ tier1: [about, home, careers] })),
    );
    expect(plan["what-they-do"].confidence).toBe("high");
    // Ranked home > about; careers falls off the MAX_SECTION_WEB_SOURCES cap.
    expect(plan["what-they-do"].sources.map((s) => s.url)).toEqual([
      home.ref.url,
      about.ref.url,
      pastedRef.url,
    ]);
  });

  it("team-signals counts about/careers pages but never the bare homepage", () => {
    const homepageOnly = byId(planSections(makeProfile(), makeEnrichment({ tier1: [home] })));
    expect(homepageOnly["team-signals"].confidence).toBe("none");
    const withAbout = byId(
      planSections(makeProfile(), makeEnrichment({ tier1: [home, careers, about] })),
    );
    expect(withAbout["team-signals"].confidence).toBe("high");
    expect(withAbout["team-signals"].sources.map((s) => s.url)).toEqual([
      about.ref.url,
      careers.ref.url,
    ]);
  });

  it("stack is grounded by github/blog/careers, never by the homepage alone", () => {
    const homepageOnly = byId(planSections(makeProfile(), makeEnrichment({ tier1: [home] })));
    expect(homepageOnly.stack.confidence).toBe("none");
    const grounded = byId(
      planSections(makeProfile(), makeEnrichment({ tier1: [home, careers], tier2: [github] })),
    );
    expect(grounded.stack.confidence).toBe("high");
    expect(grounded.stack.sources.map((s) => s.url)).toEqual([github.ref.url, careers.ref.url]);
  });

  it("recent-launches needs blog/changelog/news and ranks the changelog first", () => {
    const plan = byId(
      planSections(
        makeProfile(),
        makeEnrichment({ tier2: [blog, changelog], tier3: [news] }),
      ),
    );
    expect(plan["recent-launches"].confidence).toBe("high");
    // Changelog outranks the blog; news falls off the cap.
    expect(plan["recent-launches"].sources.map((s) => s.url)).toEqual([
      changelog.ref.url,
      blog.ref.url,
    ]);
  });

  it("caps web sources per section and excerpt length (surrogate-safe)", () => {
    const extra = { ref: webRef("https://acme.dev/jobs", "Jobs"), text: "Openings." };
    const product = {
      ref: webRef("https://acme.dev/product", "Product"),
      text: `${"p".repeat(SECTION_EXCERPT_CAP - 1)}😀`,
    };
    const plan = byId(
      planSections(
        makeProfile(),
        makeEnrichment({ tier1: [home, about, careers, extra, product] }),
      ),
    );
    // 3 web + the listing.
    expect(plan["what-they-do"].sources).toHaveLength(MAX_SECTION_WEB_SOURCES + 1);
    const capped = byId(planSections(makeProfile(), makeEnrichment({ tier1: [product] })));
    const excerpt = capped["product-area"].excerpts[0].text;
    expect(excerpt.length).toBeLessThanOrEqual(SECTION_EXCERPT_CAP);
    expect(excerpt.endsWith("\uD83D")).toBe(false); // no severed surrogate
  });

  it("ranking ignores the registrable domain: productboard.com does not score 'product' everywhere", () => {
    // Review finding: full-URL token matching let the company DOMAIN win the
    // ranking, pushing the real /product page off the source cap.
    const pbHome = { ref: webRef("https://productboard.com/", "Productboard"), text: "Home." };
    const pbAbout = { ref: webRef("https://productboard.com/about", "About"), text: "About." };
    const pbProduct = { ref: webRef("https://productboard.com/product", "Product"), text: "The product." };
    const plan = byId(
      planSections(makeProfile(), makeEnrichment({ tier1: [pbHome, pbAbout, pbProduct] })),
    );
    expect(plan["product-area"].sources[0].url).toBe(pbProduct.ref.url);
  });

  it("subdomain tokens still rank: changelog.acme.dev beats the plain blog", () => {
    const blog = { ref: webRef("https://acme.dev/blog", "Blog"), text: "Posts." };
    const changelogHost = { ref: webRef("https://changelog.acme.dev/", "Changelog"), text: "v2 shipped." };
    const plan = byId(
      planSections(makeProfile(), makeEnrichment({ tier2: [blog, changelogHost] })),
    );
    expect(plan["recent-launches"].sources.map((s) => s.url)).toEqual([
      changelogHost.ref.url,
      blog.ref.url,
    ]);
  });

  it("a source with blank stored text grounds nothing", () => {
    const blank = { ref: webRef("https://acme.dev/about", "About"), text: "   " };
    const plan = byId(planSections(makeProfile(), makeEnrichment({ tier1: [blank] })));
    expect(plan["what-they-do"].confidence).toBe("low");
    expect(plan["what-they-do"].sources).toEqual([pastedRef]);
  });
});
