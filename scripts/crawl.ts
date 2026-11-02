/**
 * Measures the tracked repositories and writes reports, badges, cards and the leaderboard.
 *
 *   GITHUB_TOKEN=… tsx scripts/crawl.ts --data .data [--max 120] [--reserve 150] [--refresh-hours 20]
 *
 * The data directory holds:
 *   repos.json         { generatedAt, top: string[] }   the most-starred active repos (refreshed weekly)
 *   tracked.json       { repos: string[] }              repos added on request
 *   skip.json          { [fullName]: reason }           repos that cannot be measured
 *   data/repos/<owner>/<repo>.json, badge/…, card/…, data/leaderboard.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildReport, DEFAULTS, fetchRepoData, type RepoData } from "../src/core/analyze";
import { badgePath, buildBoard, cardPath, reportPath, toEntry, type Board, type BoardEntry } from "../src/core/dataset";
import { GitHubClient, GitHubError } from "../src/core/github";
import { renderBadge, renderCard, shieldsJson } from "../src/core/render";
import { REPORT_SCHEMA, type Report } from "../src/core/types";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const DATA = arg("--data", ".data");
const MAX = Number(arg("--max", "120"));
const RESERVE = Number(arg("--reserve", "150"));
const REFRESH_HOURS = Number(arg("--refresh-hours", "20"));
const TOP_N = Number(arg("--top", "1000"));
const RAW = arg("--raw", "");
const RECLASSIFY = args.includes("--reclassify");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token && !RECLASSIFY) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}
const client = new GitHubClient({ token, userAgent: "howmuchai-crawler" });

function readJson<T>(file: string, fallback: T): T {
  const p = join(DATA, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
}
function writeFile(file: string, content: string) {
  const p = join(DATA, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

interface SearchResult {
  items: { full_name: string; archived: boolean; fork: boolean }[];
}

async function refreshTop(): Promise<string[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const out: string[] = [];
  for (let page = 1; page <= Math.ceil(TOP_N / 100); page++) {
    const q = encodeURIComponent(`stars:>1000 pushed:>${since} archived:false fork:false`);
    const res = await client.get<SearchResult>(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`);
    for (const it of res.items) if (!it.archived && !it.fork) out.push(it.full_name);
    if (res.items.length < 100) break;
    await new Promise((r) => setTimeout(r, 2500)); // search API: 30 requests per minute
  }
  return out.slice(0, TOP_N);
}

function storedReport(fullName: string): Report | null {
  const p = join(DATA, reportPath(fullName));
  if (!existsSync(p)) return null;
  try {
    const rep = JSON.parse(readFileSync(p, "utf8")) as Report;
    return rep.schema === REPORT_SCHEMA ? rep : null; // older schema: measure again
  } catch {
    return null;
  }
}

function writeReport(raw: RepoData): Report {
  const rep = buildReport(raw);
  writeFile(reportPath(rep.repo.fullName), JSON.stringify(rep) + "\n");
  writeFile(badgePath(rep.repo.fullName), renderBadge(rep));
  writeFile(badgePath(rep.repo.fullName).replace(/\.svg$/, ".json"), JSON.stringify(shieldsJson(rep)));
  writeFile(cardPath(rep.repo.fullName, "dark"), renderCard(rep, "dark"));
  writeFile(cardPath(rep.repo.fullName, "light"), renderCard(rep, "light"));
  return rep;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

async function main() {
  if (RECLASSIFY) {
    if (!RAW) throw new Error("--reclassify needs --raw <dir>");
    let n = 0;
    for (const f of walk(RAW)) {
      writeReport(JSON.parse(readFileSync(f, "utf8")) as RepoData);
      n++;
    }
    console.log(`rebuilt ${n} reports from raw data`);
  }
  let top = readJson<{ generatedAt: string; top: string[] }>("repos.json", { generatedAt: "1970-01-01T00:00:00Z", top: [] });
  if (!RECLASSIFY && (Date.now() - Date.parse(top.generatedAt) > 7 * 86_400_000 || top.top.length === 0)) {
    console.log("refreshing the list of top repositories");
    top = { generatedAt: new Date().toISOString(), top: await refreshTop() };
    writeFile("repos.json", JSON.stringify(top, null, 1) + "\n");
  }
  const tracked = readJson<{ repos: string[] }>("tracked.json", { repos: [] });
  // Repos that answered 404/451. Entries expire after a week, then the repo is tried again.
  type Skip = { status: number; message: string; at: string };
  const rawSkip = readJson<Record<string, Skip | string>>("skip.json", {});
  const skip: Record<string, Skip> = {};
  for (const [k, v] of Object.entries(rawSkip)) {
    if (typeof v === "string") continue; // old format without a date: try again
    if (Date.now() - Date.parse(v.at) < 7 * 86_400_000) skip[k] = v;
  }
  const all = [...new Map([...top.top, ...tracked.repos].map((r) => [r.toLowerCase(), r])).values()];

  // oldest measurement first; never-measured first of all
  const due = all
    .filter((r) => !skip[r.toLowerCase()])
    .map((r) => ({ r, at: storedReport(r)?.generatedAt ?? "" }))
    .filter((x) => !x.at || Date.now() - Date.parse(x.at) > REFRESH_HOURS * 3_600_000)
    .sort((a, b) => a.at.localeCompare(b.at));
  console.log(`${all.length} repos, ${due.length} due, measuring up to ${MAX}`);

  let done = 0;
  let stop = false;
  const queue = RECLASSIFY ? [] : due.map((d) => d.r);
  const CONCURRENCY = Number(arg("--concurrency", "3"));
  async function worker() {
    while (!stop && queue.length > 0 && done < MAX) {
      if (client.lastRate && client.lastRate.remaining < RESERVE) {
        console.log(`stopping: ${client.lastRate.remaining} requests left`);
        stop = true;
        return;
      }
      const r = queue.shift()!;
      try {
        const raw = await fetchRepoData(r, { client });
        if (RAW) {
          const p = join(RAW, `${raw.repo.fullName.toLowerCase()}.json`);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, JSON.stringify(raw));
        }
        const rep = writeReport(raw);
        done++;
        console.log(`${String(done).padStart(4)} ${rep.repo.fullName}: ${rep.commits.ai}/${rep.commits.total} commits, ${rep.pulls.ai}/${rep.pulls.total} PRs`);
      } catch (e) {
        if (e instanceof GitHubError && e.resetAt) {
          console.log("rate limit reached, stopping");
          stop = true;
          return;
        }
        if (e instanceof GitHubError && [404, 451].includes(e.status)) {
          skip[r.toLowerCase()] = { status: e.status, message: e.message, at: new Date().toISOString() };
          console.log(`skip ${r}: ${e.status}`);
          continue;
        }
        console.log(`error ${r}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFile("skip.json", JSON.stringify(skip, null, 1) + "\n");

  // leaderboard from every stored report that is selected or tracked; statistics use the top cohort only
  const entries: BoardEntry[] = [];
  const reposDir = join(DATA, "data/repos");
  if (existsSync(reposDir)) {
    for (const owner of readdirSync(reposDir)) {
      for (const f of readdirSync(join(reposDir, owner))) {
        const rep = JSON.parse(readFileSync(join(reposDir, owner, f), "utf8")) as Report;
        if (rep.schema === REPORT_SCHEMA) entries.push(toEntry(rep));
      }
    }
  }
  const board: Board = buildBoard(entries, top.top, tracked.repos, top.generatedAt, DEFAULTS.days, new Date());
  writeFile("data/leaderboard.json", JSON.stringify(board) + "\n");
  console.log(`measured ${done}, leaderboard has ${board.repos.length} repos (top cohort ${board.cohort?.measured}/${board.cohort?.selected}), ${client.requests} requests, ${client.lastRate?.remaining ?? "?"} left`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
