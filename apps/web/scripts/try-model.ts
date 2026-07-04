// Increment 2 smoke proof (PLAN.md §7): extract() a zod-validated object from
// a sentence, then stream a two-sentence completion chunk-by-chunk.
//
//   cd apps/web && npx tsx scripts/try-model.ts
//
// Provider comes from .env.local (or the environment): a cloud key, or
// MODEL_PROVIDER=ollama with local Ollama running. Unconfigured runs exit
// with the MODEL_UNCONFIGURED message naming the env vars.
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isPipelineError } from "../src/domain/pipeline/errors";
import { createModelProvider } from "../src/providers/model/createModelProvider";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // No .env.local — plain process.env still works.
}

const PersonSchema = z.object({ name: z.string(), city: z.string() });

async function main(): Promise<void> {
  const provider = createModelProvider();
  console.log(`provider: ${provider.id}`);

  console.log("\n--- extract() ---");
  const person = await provider.extract(
    "Extract the person described here: Maya Chen is a software engineer living in Lisbon.",
    PersonSchema,
  );
  console.log("zod-validated result:", person);

  console.log("\n--- streamSynthesis() ---");
  let chunks = 0;
  for await (const chunk of provider.streamSynthesis({
    prompt:
      "In exactly two short sentences, explain why a job seeker should research a company before applying.",
  })) {
    chunks += 1;
    process.stdout.write(chunk);
  }
  console.log(`\n(${chunks} chunks)`);
}

main().catch((err: unknown) => {
  if (isPipelineError(err)) {
    console.error(`\n${err.code}: ${err.message}`);
    if (err.hint) console.error(err.hint);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
