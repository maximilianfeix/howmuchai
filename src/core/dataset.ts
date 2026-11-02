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
}

export interface Board {
  schema: 1;
  generatedAt: string;
  days: number;
  repos: BoardEntry[];
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
  };
}

/** Path of a stored report, relative to the site root. Lower-case because GitHub names are case-insensitive. */
export function reportPath(fullName: string): string {
  return `data/repos/${fullName.toLowerCase()}.json`;
}

export function badgePath(fullName: string): string {
  return `badge/${fullName.toLowerCase()}.svg`;
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
