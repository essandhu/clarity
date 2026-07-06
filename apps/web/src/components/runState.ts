import type {
  Confidence,
  FetchSkip,
  Hook,
  ListingProfile,
  PipelineEvent,
  SectionId,
  SourceRef,
  Stage,
  TierNumber,
  TierStatus,
} from "@/shared/schema";

// Client run state (PLAN.md §6) + the reducer's action union. Pre-split from
// runReducer.ts under the ~200-line ceiling: shapes here, transitions there.

export interface StepView {
  stepId: string;
  stage: Stage;
  label: string;
  url?: string;
  tier?: TierNumber;
  status: "running" | "ok" | "skipped";
  skip?: FetchSkip;
  source?: SourceRef;
  cached?: boolean;
}

export interface SectionView {
  title: string;
  confidence: Confidence;
  sources: SourceRef[];
  text: string;
  done: boolean;
}

export interface RunState {
  phase: "idle" | "running" | "done" | "error" | "cancelled";
  runId?: string;
  provider?: { id: string };
  budget?: { maxFetches: number; deadlineMs: number };
  /** Duplicate/ordering guard: wire frames with seq <= lastSeq are dropped. */
  lastSeq: number;
  steps: StepView[];
  profile?: ListingProfile;
  tiers: Partial<Record<TierNumber, { status: TierStatus; sources: SourceRef[] }>>;
  /** Budgeted fetches spent — lands with enrichment.completed (then again,
   *  authoritatively, with run.completed). CoverageSummary's "7/12" tally. */
  fetchesUsed?: number;
  budgetNotice?: { kind: "fetches" | "wall_clock"; skippedTiers: number[] };
  sections: Partial<Record<SectionId, SectionView>>;
  sectionOrder: SectionId[];
  hooks: Hook[];
  fatal?: { code: string; message: string; hint?: string };
}

export const initialRunState: RunState = {
  phase: "idle",
  lastSeq: -1,
  steps: [],
  tiers: {},
  sections: {},
  sectionOrder: [],
  hooks: [],
};

// The four local actions (§6). `aborted` is the authoritative close-out for
// client-initiated cancellation: the server sends no pairing frames on a dead
// connection (§3 ordering guarantee 3).
export type LocalAction =
  | { type: "submit" }
  | { type: "aborted" }
  | { type: "reset" }
  | { type: "transport_error"; message?: string };

/** A wire frame: the seq comes from the SSE `id:` field, not the payload. */
export interface WireAction {
  seq: number;
  event: PipelineEvent;
}

export type RunAction = WireAction | LocalAction;
