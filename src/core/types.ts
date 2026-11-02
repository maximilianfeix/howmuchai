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
  kind: SignalKind;
  /** JavaScript regular expression source, matched case-insensitively. */
  pattern: string;
  confidence: Confidence;
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
  url: string;
}

export interface Match {
  agentId: string;
  kind: SignalKind;
  /** The text that matched, trimmed, for the evidence list. */
  matched: string;
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
}

export interface MonthBucket {
  /** "2026-10" */
  month: string;
  total: number;
  ai: number;
  byAgent: Record<string, number>;
}

export interface Section {
  /** Items considered (after leaving out merges and ignored bots). */
  total: number;
  /** Items with at least one AI signal. */
  ai: number;
  byAgent: Record<string, number>;
  byMonth: MonthBucket[];
  evidence: Evidence[];
  /** True if the item cap was reached before the start of the window. */
  capped: boolean;
  /** Date of the oldest item looked at. */
  oldest: string | null;
}

export interface Report {
  schema: 1;
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
  generatedAt: string;
}
