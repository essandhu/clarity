import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// Layering rule (PLAN.md §4, decision 23): src/domain/** is framework-free and
// may import only src/shared/schema, other domain modules, and provider
// *interface* files. Everything below is gitignore-style `patterns` (not
// `paths`) so deep subpaths (cheerio/slim, next/font/google) and path-aliased
// or relative escapes (@/server/deps, ../../providers/...) are covered too.
const DOMAIN_IMPORT_BANS = [
  {
    group: ["next", "next/*"],
    message: "src/domain/** is framework-free. Route adapters live in app/api.",
  },
  {
    group: ["ai", "ai/*"],
    message: "Model access goes through the ModelProvider interface.",
  },
  {
    group: ["jsdom", "jsdom/*", "cheerio", "cheerio/*"],
    message: "Page cleaning lives behind the PageFetcher provider.",
  },
  {
    group: ["cockatiel", "cockatiel/*"],
    message: "Resilience policy lives behind the PageFetcher provider.",
  },
  {
    group: ["bottleneck", "bottleneck/*"],
    message: "Rate limiting lives behind the PageFetcher provider.",
  },
  {
    group: ["fs", "node:fs", "fs/promises", "node:fs/promises"],
    message: "The domain layer does no I/O. Use an injected provider.",
  },
  {
    group: ["@/server/**", "**/src/server/**", "**/server/deps", "**/server/sse"],
    message:
      "The composition root and SSE adapter are server glue — they call the domain, never the reverse.",
  },
  {
    group: ["@/components/**", "**/components/**"],
    message: "UI components consume domain output over the wire, never the reverse.",
  },
  {
    // A leading **/ also matches the @/ alias, so one spelling covers aliased
    // AND relative escapes. The five interface seams (types only) are the
    // sanctioned imports. Gitignore semantics: a negation cannot re-include a
    // file whose parent directory stays excluded, so each interface's parent
    // dir is re-included immediately before the interface file itself.
    group: [
      "**/providers/**",
      "!**/providers/model",
      "!**/providers/model/ModelProvider",
      "!**/providers/fetch",
      "!**/providers/fetch/PageFetcher",
      "!**/providers/contact",
      "!**/providers/contact/ContactSource",
      "!**/providers/search",
      "!**/providers/search/SearchProvider",
      "!**/providers/cache",
      "!**/providers/cache/PageCache",
    ],
    message:
      "src/domain may import provider *interface* files only (ModelProvider, PageFetcher, ContactSource, SearchProvider, PageCache) — implementations and fakes are wired in by src/server/deps.",
  },
];

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    files: ["src/domain/**/*.ts", "src/domain/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: DOMAIN_IMPORT_BANS }],
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
