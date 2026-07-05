"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { AnalyzeInputSchema, type AnalyzeInput } from "@/shared/schema";

// URL | paste-text toggle + provider chip from GET /api/health (PLAN.md §6).
// Client-side validation mirrors AnalyzeInputSchema so obviously-bad input
// never even opens a stream.

const HealthSchema = z.object({
  provider: z.object({
    id: z.string(),
    model: z.string().optional(),
    reachable: z.boolean().optional(),
  }),
});

type Health = z.infer<typeof HealthSchema>["provider"];

function providerChip(health: Health | undefined): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!health) return { text: "checking model…", tone: "muted" };
  switch (health.id) {
    case "anthropic":
      return { text: "Claude · your key", tone: "ok" };
    case "openai":
      return { text: "OpenAI · your key", tone: "ok" };
    case "ollama":
      return health.reachable === false
        ? { text: "Ollama · not reachable", tone: "warn" }
        : { text: "Ollama · local", tone: "ok" };
    default:
      return { text: "no model configured", tone: "warn" };
  }
}

export interface ListingInputFormProps {
  disabled: boolean;
  onSubmit(input: AnalyzeInput): void;
}

/**
 * Pure validation mirror of AnalyzeInputSchema, exported for unit tests.
 * Every schema failure gets copy the user can act on — the too_big side of
 * the text bound must never masquerade as "paste more" (input allows 50k;
 * only the first 20k is analyzed — see CLAUDE.md's rawText deviation).
 */
export function validateListingInput(
  mode: "text" | "url",
  raw: { text: string; url: string },
): { input: AnalyzeInput } | { error: string } {
  const candidate: unknown =
    mode === "url" ? { kind: "url", url: raw.url.trim() } : { kind: "text", text: raw.text };
  const parsed = AnalyzeInputSchema.safeParse(candidate);
  if (parsed.success) return { input: parsed.data };
  if (mode === "url") return { error: "Enter a full http(s) link to the listing." };
  return parsed.error.issues.some((issue) => issue.code === "too_big")
    ? {
        error:
          "That paste is over the 50,000-character limit — trim it down (only the first 20,000 characters are analyzed anyway).",
      }
    : { error: "Paste at least 40 characters of listing text." };
}

export function ListingInputForm({ disabled, onSubmit }: ListingInputFormProps) {
  const [mode, setMode] = useState<"text" | "url">("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const [health, setHealth] = useState<Health>();

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: unknown) => {
        const parsed = HealthSchema.safeParse(body);
        if (alive && parsed.success) setHealth(parsed.data.provider);
      })
      .catch(() => {
        // Health is advisory; the chip just stays in its loading state.
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    const result = validateListingInput(mode, { text, url });
    if ("error" in result) {
      setInvalid(result.error);
      return;
    }
    setInvalid(undefined);
    onSubmit(result.input);
  };

  // A stale error would describe the input the user is no longer looking at.
  const switchMode = (next: "text" | "url") => {
    setMode(next);
    setInvalid(undefined);
  };

  const chip = providerChip(health);

  return (
    <form className="input-form" onSubmit={submit}>
      <div className="input-form-top">
        {/* Plain toggle buttons on purpose: tab ARIA would advertise a
            keyboard contract (arrow keys, tabpanel linkage) these don't have. */}
        <div className="mode-toggle" aria-label="Listing input mode">
          <button
            type="button"
            aria-pressed={mode === "text"}
            className={mode === "text" ? "mode-tab active" : "mode-tab"}
            onClick={() => switchMode("text")}
          >
            Paste text
          </button>
          <button
            type="button"
            aria-pressed={mode === "url"}
            className={mode === "url" ? "mode-tab active" : "mode-tab"}
            onClick={() => switchMode("url")}
          >
            Listing URL
          </button>
        </div>
        <span className={`provider-chip provider-${chip.tone}`} title="Configured model provider">
          {chip.text}
        </span>
      </div>

      {mode === "text" ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder="Paste the full job listing text here…"
          disabled={disabled}
          aria-label="Job listing text"
        />
      ) : (
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/careers/senior-engineer"
          disabled={disabled}
          aria-label="Job listing URL"
        />
      )}

      {invalid && <p className="input-error">{invalid}</p>}

      <button type="submit" className="primary-button" disabled={disabled}>
        {disabled ? "Analyzing…" : "Analyze listing"}
      </button>
    </form>
  );
}
