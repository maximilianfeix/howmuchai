import { createClassifier, type Classifier } from "./classify";
import { GitHubClient } from "./github";
import { registry } from "./registry";
import type { CommitInput, Evidence, Match, MonthBucket, PullInput, Report, Section } from "./types";

export const VERSION = "0.1.0";

export interface AnalyzeOptions {
  days?: number;
  maxCommits?: number;
  maxPulls?: number;
  client?: GitHubClient;
  now?: Date;
  /** Max evidence items kept per section. */
  evidenceLimit?: number;
}

export const DEFAULTS = { days: 90, maxCommits: 500, maxPulls: 300, evidenceLimit: 40 } as const;

/** Accepts "owner/repo", a github.com URL, or "github.com/owner/repo". Returns "owner/repo" or null. */
export function parseRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(s);
  if (!m) return null;
  if (m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

function emptySection(): Section {
  return { total: 0, ai: 0, byAgent: {}, hints: 0, hintsByAgent: {}, byMonth: [], evidence: [], capped: false, oldest: null };
}

function bucket(months: Map<string, MonthBucket>, date: string): MonthBucket {
  const month = date.slice(0, 7);
  let b = months.get(month);
  if (!b) {
    b = { month, total: 0, ai: 0, byAgent: {} };
    months.set(month, b);
  }
  return b;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim().slice(0, 140);
}

/**
 * Counts one item. Matches are ordered by the classifier (high confidence first), so the first match is the
 * primary agent. Items with only medium-confidence matches become hints and stay out of `ai`.
 * Returns true if the item had any match.
 */
function count(sec: Section, b: MonthBucket, matches: Match[]): boolean {
  const first = matches[0];
  if (!first) return false;
  if (first.confidence === "high") {
    sec.ai++;
    b.ai++;
    sec.byAgent[first.agentId] = (sec.byAgent[first.agentId] ?? 0) + 1;
    b.byAgent[first.agentId] = (b.byAgent[first.agentId] ?? 0) + 1;
  } else {
    sec.hints++;
    sec.hintsByAgent[first.agentId] = (sec.hintsByAgent[first.agentId] ?? 0) + 1;
  }
  return true;
}

export function summarizeCommits(items: CommitInput[], cls: Classifier, evidenceLimit: number): Section {
  const sec = emptySection();
  const months = new Map<string, MonthBucket>();
  for (const c of items) {
    if (cls.isIgnoredCommit(c)) continue;
    sec.total++;
    if (!sec.oldest || c.date < sec.oldest) sec.oldest = c.date;
    const b = bucket(months, c.date);
    b.total++;
    const matches = cls.commit(c);
    if (!count(sec, b, matches)) continue;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0]!, c.sha.slice(0, 7), firstLine(c.message), c.date, c.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}

export function summarizePulls(items: PullInput[], cls: Classifier, evidenceLimit: number): Section {
  const sec = emptySection();
  const months = new Map<string, MonthBucket>();
  for (const p of items) {
    if (cls.isIgnoredPull(p)) continue;
    sec.total++;
    if (!sec.oldest || p.createdAt < sec.oldest) sec.oldest = p.createdAt;
    const b = bucket(months, p.createdAt);
    b.total++;
    const matches = cls.pull(p);
    if (!count(sec, b, matches)) continue;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0]!, `#${p.number}`, p.title.slice(0, 140), p.createdAt, p.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}

function toEvidence(m: Match, ref: string, title: string, date: string, url: string): Evidence {
  return { agentId: m.agentId, signalId: m.signalId, kind: m.kind, ref, title, date, url, matched: m.matched, confidence: m.confidence };
}

/** Everything fetched from GitHub for one repository; enough to rebuild a report offline. */
export interface RepoData {
  repo: Awaited<ReturnType<GitHubClient["repo"]>>;
  commits: { items: CommitInput[]; capped: boolean };
  pulls: { items: PullInput[]; capped: boolean };
  since: string;
  until: string;
  days: number;
}

export async function fetchRepoData(input: string, opts: AnalyzeOptions = {}): Promise<RepoData> {
  const fullName = parseRepo(input);
  if (!fullName) throw new Error(`Not a GitHub repository: ${input}`);
  const days = opts.days ?? DEFAULTS.days;
  const client = opts.client ?? new GitHubClient();
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const repo = await client.repo(fullName);
  const [commits, pulls] = await Promise.all([
    client.commits(repo.fullName, since, opts.maxCommits ?? DEFAULTS.maxCommits),
    client.pulls(repo.fullName, since, opts.maxPulls ?? DEFAULTS.maxPulls),
  ]);
  return { repo, commits, pulls, since, until: now.toISOString(), days };
}

export function buildReport(d: RepoData, opts: { evidenceLimit?: number } = {}): Report {
  const evidenceLimit = opts.evidenceLimit ?? DEFAULTS.evidenceLimit;
  const cls = createClassifier(registry);
  const cSec = summarizeCommits(d.commits.items, cls, evidenceLimit);
  cSec.capped = d.commits.capped;
  const pSec = summarizePulls(d.pulls.items, cls, evidenceLimit);
  pSec.capped = d.pulls.capped;
  return {
    schema: 2,
    tool: { name: "howmuchai", version: VERSION, registry: registry.version },
    repo: {
      fullName: d.repo.fullName,
      url: d.repo.url,
      description: d.repo.description,
      stars: d.repo.stars,
      defaultBranch: d.repo.defaultBranch,
      language: d.repo.language,
    },
    window: { since: d.since, until: d.until, days: d.days },
    commits: cSec,
    pulls: pSec,
    share: cSec.total > 0 ? cSec.ai / cSec.total : null,
    generatedAt: d.until,
  };
}

export async function analyzeRepo(input: string, opts: AnalyzeOptions = {}): Promise<Report> {
  return buildReport(await fetchRepoData(input, opts), opts);
}
