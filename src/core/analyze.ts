import { createClassifier, type Classifier } from "./classify";
import { AbortedError, GitHubClient } from "./github";
import { registry } from "./registry";
import { prevalence } from "./estimate";
import modelJson from "./style-model.json";
import { isJudgeable, score, type StyleModel } from "./style";
import type { Beyond, CommitInput, Evidence, Match, MonthBucket, PullInput, Report, Section } from "./types";

export const styleModel = modelJson as StyleModel;

export const VERSION = "0.1.0";

export interface AnalyzeOptions {
  /** Also collect evidence beyond signatures (two to four extra requests). Default true. */
  beyond?: boolean;
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
  return { fetched: 0, total: 0, ai: 0, byAgent: {}, hints: 0, hintsByAgent: {}, byMonth: [], evidence: [], capped: false, oldest: null };
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
  sec.fetched = items.length;
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
  sec.fetched = items.length;
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
  /** Commits from before July 2022, the repo's human baseline (only fetched when needed). */
  baseline?: CommitInput[] | null;
  /** Agent setup files, null when not looked up. */
  setup?: { path: string; agentId: string }[] | null;
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
    client.commits(repo.fullName, since, opts.maxCommits ?? DEFAULTS.maxCommits, now.toISOString()),
    client.pulls(repo.fullName, since, opts.maxPulls ?? DEFAULTS.maxPulls, now.toISOString()),
  ]);
  const data: RepoData = { repo, commits, pulls, since, until: now.toISOString(), days, baseline: null, setup: null };
  if (opts.beyond !== false) {
    // Supplemental evidence: a failure here (rate limit, network) never costs the signature report.
    const optional = async <T>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        return null;
      }
    };
    data.setup = await optional(() => client.agentSetup(repo.fullName));
    // The baseline costs one request; only fetch it when the gate can pass.
    const cls = createClassifier(registry);
    const disclosed = commits.items.filter((c) => !cls.isIgnoredCommit(c) && cls.commit(c).some((m) => m.confidence === "high")).length;
    if (disclosed >= GATE_DISCLOSED) data.baseline = await optional(() => client.baseline(repo.fullName));
  }
  return data;
}

/** Minimum disclosed commits before the experimental estimate is made (see eval/STYLE.md). */
export const GATE_DISCLOSED = 10;

/** Accounts of agents themselves; they are not "people who disclose agent use". */
const AGENT_ACCOUNT = /\[bot\]$|^(copilot|cursoragent|claude|devin-ai-integration|google-labs-jules|openhands(-agent)?|opencode-agent|capy-ai)$/i;

/** Widest interval that is still shown (share points, 0..1). */
export const MAX_RANGE = 0.5;

/** Minimum judgeable undisclosed commits for an estimate. */
export const MIN_JUDGEABLE = 20;

export function beyondSignatures(d: RepoData, cls: Classifier): Beyond {
  const items = d.commits.items.filter((c) => !cls.isIgnoredCommit(c));
  const signed = new Set<CommitInput>();
  for (const c of items) if (cls.commit(c).some((m) => m.confidence === "high")) signed.add(c);

  // One identity per person: the login when known; an e-mail address maps to the login it was seen with.
  const loginByEmail = new Map<string, string>();
  for (const c of items) if (c.authorLogin && c.authorEmail) loginByEmail.set(c.authorEmail.toLowerCase(), c.authorLogin.toLowerCase());
  const who = (c: CommitInput): string | null => {
    const login = c.authorLogin?.toLowerCase() ?? (c.authorEmail ? loginByEmail.get(c.authorEmail.toLowerCase()) : undefined);
    if (login) return AGENT_ACCOUNT.test(login) ? null : `@${login}`;
    if (c.authorEmail) return `<${c.authorEmail.toLowerCase()}>`;
    return null;
  };
  const people = items.filter((c) => who(c) !== null);
  const aiAuthors = new Set([...signed].map(who).filter((x): x is string => x !== null));
  const beyond: Beyond = {
    setup: d.setup ?? null,
    authors: { aiAuthors: aiAuthors.size, authors: new Set(people.map(who)).size, commitsByAiAuthors: people.filter((c) => aiAuthors.has(who(c)!)).length },
    estimate: null,
    likely: null,
    reason: null,
    model: styleModel.version,
  };
  if (items.length === 0) return { ...beyond, reason: "no-commits" };
  // Only repos that disclose agent use themselves are estimated: their disclosed commits show what agent work
  // looks like there. Setup files alone are not enough (meta/rocksdb and neovim would come out near 100%).
  if (signed.size < GATE_DISCLOSED) return { ...beyond, reason: (d.setup?.length ?? 0) > 0 ? "setup-only" : "no-evidence" };
  const gate = "disclosed" as const;
  // Bots write in templates; their commits are neither human nor agent writing and stay out of the estimate.
  const isBot = (c: CommitInput) => /\[bot\]$/i.test(c.authorLogin ?? "") || /\[bot\]$/i.test(c.authorName ?? "");
  const unsigned = items.filter((c) => !signed.has(c));
  const undisclosed = unsigned.filter((c) => !isBot(c));
  const bots = unsigned.length - undisclosed.length;
  // Only messages long enough to carry style are scored; short ones stay unknown and widen the range.
  const judged = undisclosed.filter((c) => isJudgeable(c.message));
  const short = undisclosed.length - judged.length;
  if (judged.length < MIN_JUDGEABLE) return { ...beyond, reason: undisclosed.length === 0 ? "all-disclosed" : "too-few-judgeable" };
  const S = judged.map((c) => score(styleModel, c.message));
  // What agent work looks like here: always this repo's own disclosed commits, never the training data
  // (with the training mean, the Linux kernel's long human messages came out at 100%).
  const signedJudged = [...signed].filter((c) => isJudgeable(c.message));
  if (signedJudged.length < GATE_DISCLOSED) return { ...beyond, reason: "too-few-disclosed" };
  const A = signedJudged.map((c) => score(styleModel, c.message));
  // What human work looks like here: the repo's own commits from before July 2022. Only a repo without
  // any such history (created later) may use the training data instead.
  const history = (d.baseline ?? []).filter((c) => !cls.isIgnoredCommit(c) && !isBot(c));
  const ownHuman = history.filter((c) => isJudgeable(c.message));
  let H: number[] | number;
  if (ownHuman.length >= 30) H = ownHuman.map((c) => score(styleModel, c.message));
  else if (d.baseline && d.baseline.length === 0) H = styleModel.humanMean;
  else return { ...beyond, reason: "too-little-history" };
  const p = prevalence(S, H, A, 42, 400, 0.2);
  if (!p) return { ...beyond, reason: "inseparable" };
  // Overall: the short commits are unknown, so the low end counts none of them and the high end all of them;
  // the best estimate assumes they follow the judged ones. Bot commits count as not AI-involved.
  const n = items.length;
  const likely = {
    point: (signed.size + p.point * undisclosed.length) / n,
    lo: (signed.size + p.lo * judged.length) / n,
    hi: (signed.size + p.hi * judged.length + short) / n,
  };
  // A range wider than half the scale says little and is easy to misread; this applies to what is shown.
  if (p.hi - p.lo > MAX_RANGE || likely.hi - likely.lo > MAX_RANGE) return { ...beyond, reason: "too-uncertain" };
  beyond.estimate = {
    ...p,
    gate,
    humanReference: typeof H === "number" ? "training" : "own-history",
    aiReference: typeof A === "number" ? "training" : "repo",
    tooShort: short,
    judged: judged.length,
    bots,
  };
  beyond.likely = likely;
  return beyond;
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
    beyond: beyondSignatures(d, cls),
    generatedAt: d.until,
  };
}

export async function analyzeRepo(input: string, opts: AnalyzeOptions = {}): Promise<Report> {
  return buildReport(await fetchRepoData(input, opts), opts);
}
