import type { MasterProfile } from "@/shared/schema";

// The §4.10 ProfileStore seam (types only — the PageFetcher.ts precedent).
// Deliberately NOT on the domain ESLint allowlist (decision 55): the tailor
// domain receives the loaded profile AS DATA; only routes talk to the store,
// wired through src/server/deps.

export type ProfileLoad =
  | { kind: "ok"; profile: MasterProfile }
  | { kind: "empty" }
  // Durable user data, unlike the page cache: an unreadable file is a
  // first-class honest state naming the .bak restore path — never a silent
  // empty (decision 47).
  | { kind: "unreadable"; detail: string; bakPath: string };

export interface ProfileStore {
  load(signal?: AbortSignal): Promise<ProfileLoad>;
  /** Parse-gated .bak copy -> tmp write -> atomic rename. An unreadable
   *  current file moves aside to master.json.corrupt-<timestamp> — never
   *  over the .bak (decision 47). */
  save(profile: MasterProfile, signal?: AbortSignal): Promise<void>;
}
