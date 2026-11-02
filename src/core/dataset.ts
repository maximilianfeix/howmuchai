import type { Report } from "./types";

/** One row of data/leaderboard.json. */
export interface BoardEntry {
  fullName: string;
  stars: number;
  language: string | null;
  share: number | null;
  ai: number;
  total: number;
  prAi: number;
  prTotal: number;
  /** Agent with the most AI-signed commits, or null. */
  top: string | null;
  byAgent: Record<string, number>;
  capped: boolean;
  oldest: string | null;
  measuredAt: string;
  /** "top": one of the most-starred active repos. "tracked": measured because someone asked. */
  cohort: "top" | "tracked";
  /** Experimental likely AI share of all commits (disclosed plus estimated). Null without an estimate; missing in older boards. */
  likely?: { point: number; lo: number; hi: number } | null;
}

/** How complete the top cohort is. */
export interface CohortInfo {
  /** When the list of most-starred repos was taken. */
  selectedAt: string;
  selected: number;
  measured: number;
  /** Selected but not measured yet (or not measurable). */
  missing: number;
  capped: number;
  /** Measured more than 48 hours ago. */
  stale: number;
  /** Oldest measurement in the cohort. */
  oldestMeasurement: string | null;
}

export interface Board {
  schema: 1;
  generatedAt: string;
  days: number;
  /** Missing in boards written before cohorts existed. */
  cohort?: CohortInfo;
  repos: BoardEntry[];
}

/** Entries of the top cohort. Old boards without the field count as top. */
export function topCohort(b: Board): BoardEntry[] {
  return b.repos.filter((e) => (e.cohort ?? "top") === "top");
}

/** Builds the board: every stored report that is selected or tracked, with cohort statistics for the top list. */
export function buildBoard(entries: Omit<BoardEntry, "cohort">[], top: string[], tracked: string[], selectedAt: string, days: number, now: Date): Board {
  const topSet = new Set(top.map((r) => r.toLowerCase()));
  const trackedSet = new Set(tracked.map((r) => r.toLowerCase()));
  const repos: BoardEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const k = e.fullName.toLowerCase();
    if (seen.has(k)) continue;
    if (topSet.has(k)) repos.push({ ...e, cohort: "top" });
    else if (trackedSet.has(k)) repos.push({ ...e, cohort: "tracked" });
    else continue;
    seen.add(k);
  }
  repos.sort((a, b) => b.stars - a.stars);
  const topEntries = repos.filter((e) => e.cohort === "top");
  const staleBefore = now.getTime() - 48 * 3_600_000;
  const oldest = topEntries.reduce<string | null>((m, e) => (!m || e.measuredAt < m ? e.measuredAt : m), null);
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    days,
    cohort: {
      selectedAt,
      selected: topSet.size,
      measured: topEntries.length,
      missing: topSet.size - topEntries.length,
      capped: topEntries.filter((e) => e.capped).length,
      stale: topEntries.filter((e) => Date.parse(e.measuredAt) < staleBefore).length,
      oldestMeasurement: oldest,
    },
    repos,
  };
}

export function toEntry(r: Report): BoardEntry {
  const top = Object.entries(r.commits.byAgent).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    fullName: r.repo.fullName,
    stars: r.repo.stars,
    language: r.repo.language,
    share: r.share,
    ai: r.commits.ai,
    total: r.commits.total,
    prAi: r.pulls.ai,
    prTotal: r.pulls.total,
    top,
    byAgent: r.commits.byAgent,
    capped: r.commits.capped,
    oldest: r.commits.oldest,
    measuredAt: r.generatedAt,
    cohort: "top",
    likely: r.beyond?.likely ?? null,
  };
}

/** Path of a stored report, relative to the site root. Lower-case because GitHub names are case-insensitive. */
export function reportPath(fullName: string): string {
  return `data/repos/${fullName.toLowerCase()}.json`;
}

export function badgePath(fullName: string): string {
  return `badge/${fullName.toLowerCase()}.svg`;
}

/** Badge with the experimental likely range ("AI likely | 45–68%"), falling back to the disclosed lower bound ("≥13%"). */
export function likelyBadgePath(fullName: string): string {
  return `badge/likely/${fullName.toLowerCase()}.svg`;
}

export function cardPath(fullName: string, theme: "dark" | "light"): string {
  return `card/${fullName.toLowerCase()}-${theme}.svg`;
}

export function pagePath(fullName: string): string {
  return `r/${fullName.toLowerCase()}/`;
}

export function ogPath(fullName: string): string {
  return `og/${fullName.toLowerCase()}.png`;
}
