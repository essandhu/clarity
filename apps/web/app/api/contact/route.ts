import {
  CONTACT_DEADLINE_MS,
  CONTACT_MAX_FETCHES,
  surfaceContacts,
} from "@/domain/contact/ContactSurfacer";
import { isPipelineError } from "@/domain/pipeline/errors";
import { createRunBudget } from "@/domain/pipeline/RunBudget";
import { PublicSourceContactSurfacer } from "@/providers/contact/PublicSourceContactSurfacer";
import { buildServerDeps } from "@/server/deps";
import { ContactRequestSchema, type ContactResponse, type ContactSourceTried } from "@/shared/schema";

// Opt-in Stage 4 (decision 27): plain JSON — no long-running steps to
// visualize. The route re-reads needed pages through the PageFetcher under a
// small dedicated budget; page text never round-trips from the client, and
// NOTHING here is ever persisted (§7).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { code: "INPUT_INVALID", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = ContactRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      {
        code: "INPUT_INVALID",
        message: `Expected { profile, coverage }${issue ? ` — ${issue.message}` : ""}.`,
      },
      { status: 400 },
    );
  }

  const deps = buildServerDeps();
  // Configuration failures are answered before any network is spent.
  let model;
  try {
    model = deps.pipeline.getModel();
  } catch (err) {
    return errorResponse(err);
  }

  // The §7 increment-8 gate greps the server log to prove contact network is
  // user-initiated — this line is that proof's anchor.
  console.log("[clarity] /api/contact invoked — user-initiated contact search");

  const cancel = new AbortController();
  const onClientGone = () => cancel.abort(new Error("client aborted the request"));
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });

  const budget = createRunBudget(
    { maxFetches: CONTACT_MAX_FETCHES, deadlineMs: CONTACT_DEADLINE_MS, cancel: cancel.signal },
    deps.pipeline.clock,
  );
  const disposeDeadline = deps.pipeline.scheduleDeadline?.(
    () => budget.fireDeadline(),
    CONTACT_DEADLINE_MS,
  );

  const sourcesTried: ContactSourceTried[] = [];
  try {
    const surfacer = new PublicSourceContactSurfacer({
      model,
      fetcher: deps.pipeline.fetcher,
      budget,
      cancel: cancel.signal,
      onTried: (tried) => sourcesTried.push(tried),
    });
    const candidates = await surfaceContacts(parsed.data.profile, parsed.data.coverage, [
      surfacer,
    ]);
    const payload: ContactResponse = { candidates, sourcesTried };
    return Response.json(payload);
  } catch (err) {
    return errorResponse(err);
  } finally {
    disposeDeadline?.();
  }
}

function errorResponse(err: unknown): Response {
  if (isPipelineError(err)) {
    const status =
      err.code === "MODEL_UNCONFIGURED" ? 503 : err.code === "INPUT_INVALID" ? 400 : 500;
    return Response.json({ code: err.code, message: err.message, hint: err.hint }, { status });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return Response.json(
    { code: "INTERNAL", message: `Contact search failed: ${detail}` },
    { status: 500 },
  );
}
