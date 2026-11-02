/** Builds a small data directory for the browser tests and assembles the site from it. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, type RepoData } from "../src/core/analyze";
import { buildBoard, reportPath, toEntry } from "../src/core/dataset";
import { renderBadge, renderCard } from "../src/core/render";

const DATA = "e2e/.data";
rmSync(DATA, { recursive: true, force: true });

function repo(fullName: string, ai: number, total: number, extra: Partial<RepoData["repo"]> = {}): RepoData {
  const now = new Date();
  const items = Array.from({ length: total }, (_, i) => ({
    sha: `${fullName.length}${i}`.padEnd(7, "0"),
    message: i < ai ? `change ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>` : `change ${i}`,
    date: new Date(now.getTime() - (i + 1) * 3_600_000).toISOString(),
    url: `https://github.com/${fullName}/commit/${i}`,
    authorName: "Dev",
    authorEmail: "dev@example.com",
    authorLogin: "dev",
    parents: 1,
  }));
  return {
    repo: { fullName, url: `https://github.com/${fullName}`, description: `${fullName} description`, stars: 1000 + total, defaultBranch: "main", language: "TypeScript", archived: false, fork: false, ...extra },
    commits: { items, capped: false },
    pulls: { items: [], capped: false },
    since: new Date(now.getTime() - 90 * 86_400_000).toISOString(),
    until: now.toISOString(),
    days: 90,
  };
}

const repos = [repo("demo/alpha", 30, 40), repo("demo/beta", 2, 50), repo("demo/xss", 1, 31, { description: `<img src=x onerror="window.__xss=1">` })];
const reports = repos.map((r) => buildReport(r));
for (const r of reports) {
  const p = join(DATA, reportPath(r.repo.fullName));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(r));
  mkdirSync(join(DATA, "badge", r.repo.fullName.split("/")[0]!), { recursive: true });
  mkdirSync(join(DATA, "card", r.repo.fullName.split("/")[0]!), { recursive: true });
  writeFileSync(join(DATA, "badge", `${r.repo.fullName}.svg`), renderBadge(r));
  writeFileSync(join(DATA, "card", `${r.repo.fullName}-dark.svg`), renderCard(r, "dark"));
}
const board = buildBoard(reports.map(toEntry), reports.map((r) => r.repo.fullName), [], new Date().toISOString(), 90, new Date());
writeFileSync(join(DATA, "data/leaderboard.json"), JSON.stringify(board));
execFileSync("npx", ["tsx", "scripts/assemble.ts", "--site", "dist/site", "--data", DATA, "--no-og"], { stdio: "inherit" });
