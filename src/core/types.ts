/** Where a signal is looked for. */
export type SignalKind =
  | "commit-trailer" // a line in the commit message, e.g. "Co-authored-by: Claude <noreply@anthropic.com>"
  | "commit-message" // any text in the commit message, e.g. the "Generated with Claude Code" footer
  | "commit-author" // author/committer name, email or login
  | "pr-author" // login of the account that opened the pull request
  | "pr-body" // text in the pull request description
  | "pr-branch"; // head branch name of the pull request

export type Confidence = "high" | "medium";

export interface Signal {
  /** Stable id, "<agent>/<name>". */
  id: string;
  kind: SignalKind;
  /** JavaScript regular expression source, matched case-insensitively. */
  pattern: string;
  confidence: Confidence;
  /** Lower-case text a line must contain before the pattern is tried (line-based kinds only). */
  contains?: string;
  note?: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Hex color used in charts and cards. */
  color: string;
  signals: Signal[];
}

export interface Registry {
  version: number;
  agents: Agent[];
  /** Accounts that never count as AI coding agents and are left out of the totals (dependency bots etc.). */
  ignoredAuthors: string[];
}

/** The fields of a commit the classifier needs (subset of the REST "list commits" item). */
export interface CommitInput {
  sha: string;
  message: string;
  date: string;
  url: string;
  authorName?: string | null;
  authorEmail?: string | null;
  authorLogin?: string | null;
  committerName?: string | null;
  committerEmail?: string | null;
  committerLogin?: string | null;
  parents: number;
}

/** The fields of a pull request the classifier needs (subset of the REST "list pulls" item). */
export interface PullInput {
  number: number;
  title: string;
  body: string | null;
  authorLogin: string | null;
  branch: string;
  createdAt: string;
  mergedAt: string | null;
  /** Sha of the commit the merge created on the base branch. Missing in raw data stored before registry v6. */
  mergeCommitSha?: string | null;
  url: string;
}

export interface Match {
  agentId: string;
  /** Id of the signal that matched. */
  signalId: string;
  kind: SignalKind;
  /** The text that matched, trimmed, for the evidence list. */
  matched: string;
  confidence: Confidence;
}

export interface Evidence {
  agentId: string;
  kind: SignalKind;
  /** Commit SHA (7 chars) or "#123" for pull requests. */
  ref: string;
  title: string;
  date: string;
  url: string;
  matched: string;
  /** Missing in reports made before registry v2. */
  confidence?: Confidence;
  signalId?: string;
  /** Set when a commit counts because the pull request it squash-merged carries the signature. */
  viaPull?: number;
}

export interface MonthBucket {
  /** "2026-10" */
  month: string;
  total: number;
  ai: number;
  byAgent: Record<string, number>;
}

export interface Section {
  /** Items read from GitHub, before leaving out merges and dependency bots. */
  fetched: number;
  /** Items considered (after leaving out merges and ignored bots). */
  total: number;
  /** Items with at least one high-confidence AI signature. These make the headline numbers. */
  ai: number;
  byAgent: Record<string, number>;
  /** Items with only medium-confidence hints (e.g. a `codex/` branch). Shown, never counted in `ai`. */
  hints: number;
  hintsByAgent: Record<string, number>;
  byMonth: MonthBucket[];
  evidence: Evidence[];
  /** True if the window holds more items than were read (the cap was reached). */
  capped: boolean;
  /** Date of the oldest item looked at. */
  oldest: string | null;
}

/** Report schema. 2: `ai` counts high-confidence signatures only; hints are separate. */
export const REPORT_SCHEMA = 2;

/** Experimental evidence beyond signatures. Never used for the headline number, badges or the leaderboard ranking. */
export interface Beyond {
  /** Agent setup files on the default branch; null when they were not looked up. */
  setup: { path: string; agentId: string }[] | null;
  /** Commits written by people who disclose agent use in at least one other commit of this window. */
  authors: { aiAuthors: number; authors: number; commitsByAiAuthors: number };
  /** Estimated AI share of the undisclosed commits, or null when the gate is not passed. */
  estimate: null | {
    point: number;
    lo: number;
    hi: number;
    /** Why an estimate was made at all. */
    gate: "disclosed" | "setup";
    humanReference: "own-history" | "training";
    aiReference: "repo" | "training";
    /** Commits whose message is too short to carry any style signal. */
    tooShort: number;
    /** Undisclosed commits that were scored. Missing in early reports. */
    judged?: number;
    /** Unsigned commits by bot accounts, left out of the estimate and counted as not AI-involved. Missing in early reports. */
    bots?: number;
  };
  /** Disclosed plus estimated, as a share of all commits; null without an estimate. */
  likely: null | { point: number; lo: number; hi: number };
  /** Why there is no estimate; null when there is one. Missing in early reports. */
  reason?: null | "no-commits" | "no-evidence" | "setup-only" | "too-few-disclosed" | "too-little-history" | "all-disclosed" | "too-few-judgeable" | "inseparable" | "too-uncertain";
  model: number;
}

export interface Report {
  schema: 2;
  tool: { name: "howmuchai"; version: string; registry: number };
  repo: {
    fullName: string;
    url: string;
    description: string | null;
    stars: number;
    defaultBranch: string;
    language: string | null;
  };
  window: { since: string; until: string; days: number };
  commits: Section;
  pulls: Section;
  /** ai / total of commits, 0..1, or null when there are no commits in the window. */
  share: number | null;
  /** Experimental, see Beyond. Missing in older reports. */
  beyond?: Beyond;
  generatedAt: string;
}
