import { describe, expect, it } from "vitest";
import { buildReport, type RepoData } from "../src/core/analyze";
import { toEntry } from "../src/core/dataset";
import { buildStats, isStats, MIN_LANGUAGE_REPOS } from "../src/core/stats";

function report(name: string, language: string | null, signed: number, plain: number, capped = false) {
  const items = [
    ...Array.from({ length: signed }, (_, i) => ({ sha: `s${i}`, message: `Fix ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, date: i % 2 ? "2026-09-15T00:00:00Z" : "2026-10-15T00:00:00Z", url: "u", parents: 1 })),
    ...Array.from({ length: plain }, (_, i) => ({ sha: `p${i}`, message: `Tweak ${i}`, date: i % 2 ? "2026-09-15T00:00:00Z" : "2026-10-15T00:00:00Z", url: "u", parents: 1 })),
  ];
  const d: RepoData = {
    repo: { fullName: name, url: `https://github.com/${name}`, description: null, stars: 1, defaultBranch: "main", language, archived: false, fork: false },
    commits: { items, capped },
    pulls: { items: [], capped: false },
    baseline: [],
    setup: [],
    since: "2026-08-04T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    days: 90,
  };
  return buildReport(d);
}

describe("statistics", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  it("builds a monthly trend from uncapped repos only", () => {
    const a = report("a/a", "Rust", 4, 6), b = report("b/b", "Rust", 10, 0, true);
    const s = buildStats([a, b], [toEntry(a), toEntry(b)], now);
    expect(s.trend.repos).toBe(1);
    expect(s.trend.months.map((m) => [m.month, m.ai, m.total])).toEqual([["2026-09", 2, 5], ["2026-10", 2, 5]]);
    expect(isStats(s)).toBe(true);
  });

  it("marks the months the window cuts as partial", () => {
    const a = report("a/a", "Go", 2, 2);
    a.commits.byMonth.push({ month: "2026-08", total: 1, ai: 0, byAgent: {} }, { month: "2026-11", total: 1, ai: 1, byAgent: { "claude-code": 1 } });
    a.commits.byMonth.sort((x, y) => x.month.localeCompare(y.month));
    const s = buildStats([a], [toEntry(a)], now);
    // August has 28 days in the window, November only one, so November is left out
    expect(s.trend.months.map((m) => [m.month, m.partial, m.days])).toEqual([["2026-08", true, 28], ["2026-09", false, 30], ["2026-10", false, 31]]);
  });

  it("folds small languages and repos without a language into Other", () => {
    const big = Array.from({ length: MIN_LANGUAGE_REPOS }, (_, i) => report(`r/${i}`, "TypeScript", 1, 9));
    const small = [report("x/1", "Zig", 5, 5), report("x/2", null, 0, 10)];
    const all = [...big, ...small];
    const s = buildStats(all, all.map(toEntry), now);
    expect(s.languages.map((l) => l.language)).toEqual(["TypeScript", "Other"]);
    expect(s.languages[0]).toMatchObject({ repos: MIN_LANGUAGE_REPOS, withAi: MIN_LANGUAGE_REPOS, commits: 150, ai: 15 });
    expect(s.languages[1]).toMatchObject({ repos: 2, ai: 5 });
  });

  it("keeps one history point per day and appends new days", () => {
    const a = report("a/a", "Go", 3, 7);
    const s1 = buildStats([a], [toEntry(a)], now, [{ date: "2026-11-01", repos: 1, withAi: 0, commits: 5, ai: 0, byAgentRepos: {} }, { date: "2026-11-02", repos: 9, withAi: 9, commits: 9, ai: 9, byAgentRepos: {} }]);
    expect(s1.history.map((h) => h.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(s1.history[1]).toMatchObject({ repos: 1, withAi: 1, ai: 3, commits: 10, byAgentRepos: { "claude-code": 1 } });
  });

  it("leaves tracked repos out", () => {
    const a = report("a/a", "Go", 3, 7);
    const e = { ...toEntry(a), cohort: "tracked" as const };
    const s = buildStats([a], [e], now);
    expect(s.trend.repos).toBe(0);
    expect(s.history[0]!.repos).toBe(0);
  });

  it("rejects malformed statistics", () => {
    expect(isStats(null)).toBe(false);
    expect(isStats({ schema: 1, generatedAt: "x", trend: { repos: 1, months: [{ month: "2026-10", total: 1, ai: 2 }] }, languages: [], history: [] })).toBe(false);
  });
});
