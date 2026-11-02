/**
 * Statistics over the top cohort, written to data/stats.json next to the leaderboard:
 * a monthly trend, a breakdown by language and a daily history that grows with every crawl.
 */
import type { BoardEntry } from "./dataset";
import { median } from "./format";
import type { Report } from "./types";

export interface MonthPoint {
  month: string;
  total: number;
  ai: number;
  byAgent: Record<string, number>;
  /** The window starts or ends inside this month, so it covers only part of it. */
  partial: boolean;
  /** Days of the month inside the window (the most of any repo). */
  days: number;
}

/** Partial months with fewer days than this are left out of the trend: two days of November say nothing. */
export const MIN_MONTH_DAYS = 7;

function daysIn(month: string, since: string, until: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1), end = Date.UTC(y, m, 1);
  const a = Math.max(start, Date.parse(since)), b = Math.min(end, Date.parse(until));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export interface LanguageRow {
  language: string;
  repos: number;
  /** Repos with at least one AI-signed commit. */
  withAi: number;
  commits: number;
  ai: number;
  /** Median of the per-repo AI-signed share. */
  medianShare: number;
}

export interface HistoryPoint {
  /** "2026-11-02", one point per day, the last crawl of that day. */
  date: string;
  repos: number;
  withAi: number;
  commits: number;
  ai: number;
  /** Repos with at least one commit signed by each agent. */
  byAgentRepos: Record<string, number>;
}

export interface Stats {
  schema: 1;
  generatedAt: string;
  /** Monthly AI-signed share, only from repos whose whole window was read (not capped), so every month has the same repos. */
  trend: { repos: number; months: MonthPoint[] };
  languages: LanguageRow[];
  history: HistoryPoint[];
}

/** Languages with fewer repos than this are folded into "Other". */
export const MIN_LANGUAGE_REPOS = 15;
const MAX_HISTORY = 400;

export function buildStats(reports: Report[], entries: BoardEntry[], now: Date, previous: HistoryPoint[] = []): Stats {
  const top = entries.filter((e) => (e.cohort ?? "top") === "top" && e.total > 0);
  const topNames = new Set(top.map((e) => e.fullName.toLowerCase()));

  // Trend: capped repos only cover their newest weeks, which would make older months look like quieter repos.
  const full = reports.filter((r) => topNames.has(r.repo.fullName.toLowerCase()) && !r.commits.capped && r.commits.total > 0);
  const months = new Map<string, MonthPoint>();
  for (const r of full) {
    const since = r.window.since.slice(0, 7), until = r.window.until.slice(0, 7);
    for (const b of r.commits.byMonth) {
      const m = months.get(b.month) ?? { month: b.month, total: 0, ai: 0, byAgent: {}, partial: false, days: 0 };
      m.days = Math.max(m.days, daysIn(b.month, r.window.since, r.window.until));
      m.total += b.total;
      m.ai += b.ai;
      for (const [id, n] of Object.entries(b.byAgent)) m.byAgent[id] = (m.byAgent[id] ?? 0) + n;
      if (b.month === since || b.month === until) m.partial = true;
      months.set(b.month, m);
    }
  }

  // Languages.
  const byLang = new Map<string, BoardEntry[]>();
  for (const e of top) {
    const l = e.language ?? "None";
    byLang.set(l, [...(byLang.get(l) ?? []), e]);
  }
  const rows: LanguageRow[] = [];
  const other: BoardEntry[] = [];
  for (const [language, es] of byLang) {
    if (es.length < MIN_LANGUAGE_REPOS || language === "None") other.push(...es);
    else rows.push(langRow(language, es));
  }
  rows.sort((a, b) => b.ai / Math.max(1, b.commits) - a.ai / Math.max(1, a.commits) || b.repos - a.repos);
  if (other.length) rows.push(langRow("Other", other));

  // History: today's point replaces an earlier one from the same day.
  const byAgentRepos: Record<string, number> = {};
  for (const e of top) for (const id of Object.keys(e.byAgent)) byAgentRepos[id] = (byAgentRepos[id] ?? 0) + 1;
  const today: HistoryPoint = {
    date: now.toISOString().slice(0, 10),
    repos: top.length,
    withAi: top.filter((e) => e.ai > 0).length,
    commits: top.reduce((s, e) => s + e.total, 0),
    ai: top.reduce((s, e) => s + e.ai, 0),
    byAgentRepos,
  };
  const history = [...previous.filter((h) => h.date !== today.date), today].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_HISTORY);

  return {
    schema: 1,
    generatedAt: now.toISOString(),
    trend: {
      repos: full.length,
      months: [...months.values()].filter((m) => !m.partial || m.days >= MIN_MONTH_DAYS).sort((a, b) => a.month.localeCompare(b.month)),
    },
    languages: rows,
    history,
  };
}

function langRow(language: string, es: BoardEntry[]): LanguageRow {
  return {
    language,
    repos: es.length,
    withAi: es.filter((e) => e.ai > 0).length,
    commits: es.reduce((s, e) => s + e.total, 0),
    ai: es.reduce((s, e) => s + e.ai, 0),
    medianShare: median(es.map((e) => e.share ?? 0)),
  };
}

/** Light shape check for stats.json read back from disk or over the network. */
export function isStats(v: unknown): v is Stats {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<Stats>;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  return (
    s.schema === 1 &&
    typeof s.generatedAt === "string" &&
    !!s.trend &&
    n(s.trend.repos) &&
    Array.isArray(s.trend.months) &&
    s.trend.months.every((m) => typeof m?.month === "string" && /^\d{4}-\d{2}$/.test(m.month) && n(m.total) && n(m.ai) && m.ai <= m.total) &&
    Array.isArray(s.languages) &&
    s.languages.every((l) => typeof l?.language === "string" && n(l.repos) && n(l.commits) && n(l.ai) && l.ai <= l.commits && n(l.medianShare)) &&
    Array.isArray(s.history) &&
    s.history.every((h) => typeof h?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h.date) && n(h.repos) && n(h.commits) && n(h.ai) && h.ai <= h.commits)
  );
}
