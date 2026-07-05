import { describeHealth } from "@/server/deps";

// Reports which provider is configured (decision 26) — drives the UI provider
// chip without leaking keys. For Ollama it pings the CONFIGURED
// OLLAMA_BASE_URL via the composition root, so a non-default host/port never
// produces a false "unreachable".
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await describeHealth());
}
