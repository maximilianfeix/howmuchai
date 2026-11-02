import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, type RepoData } from "../src/core/analyze";
import { buildBoard, toEntry } from "../src/core/dataset";
import { validateBoard, validateReport } from "../src/core/validate";
import { writeAtomic } from "../scripts/lib/fsutil";

const raw: RepoData = {
  repo: { fullName: "o/r", url: "https://github.com/o/r", description: null, stars: 3, defaultBranch: "main", language: null, archived: false, fork: false },
  commits: {
    items: [
      { sha: "1111111", message: "a\n\nCo-Authored-By: Claude <noreply@anthropic.com>", date: "2026-10-02T00:00:00Z", url: "https://github.com/o/r/commit/1111111", parents: 1 },
      { sha: "2222222", message: "b", date: "2026-10-03T00:00:00Z", url: "https://github.com/o/r/commit/2222222", parents: 1 },
    ],
    capped: false,
  },
  pulls: { items: [], capped: false },
  since: "2026-08-04T00:00:00Z",
  until: "2026-11-02T00:00:00Z",
  days: 90,
};
const good = buildReport(raw);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("validateReport (#8)", () => {
  it("accepts a real report", () => expect(validateReport(good).ok).toBe(true));

  const broken: [string, (r: any) => void][] = [
    ["old schema", (r) => (r.schema = 1)],
    ["ai larger than total", (r) => (r.commits.ai = 9)],
    ["agents not adding up", (r) => (r.commits.byAgent = { "claude-code": 2 })],
    ["months not adding up", (r) => (r.commits.byMonth[0].total = 7)],
    ["negative count", (r) => (r.pulls.total = -1)],
    ["fractional count", (r) => (r.commits.total = 1.5)],
    ["non-GitHub evidence link", (r) => (r.commits.evidence[0].url = "javascript:alert(1)")],
    ["non-GitHub repo link", (r) => (r.repo.url = "https://evil.example/o/r")],
    ["bad repo name", (r) => (r.repo.fullName = "../../etc/passwd")],
    ["bad date", (r) => (r.generatedAt = "yesterday")],
    ["date in the future", (r) => (r.generatedAt = "2099-01-01T00:00:00Z")],
    ["inverted window", (r) => (r.window.since = "2027-01-01T00:00:00Z")],
    ["wrong share", (r) => (r.share = 0.9)],
  ];
  for (const [name, f] of broken) {
    it(`rejects ${name}`, () => {
      const r = clone(good);
      f(r);
      expect(validateReport(r).ok).toBe(false);
    });
  }
});

describe("validateBoard (#8)", () => {
  const board = buildBoard([toEntry(good)], ["o/r"], [], "2026-11-01T00:00:00Z", 90, new Date("2026-11-02T00:00:00Z"));
  it("accepts a real board", () => expect(validateBoard(board).ok).toBe(true));
  it("rejects bad entries", () => {
    const b = clone(board);
    (b.repos[0] as any).ai = 1000;
    expect(validateBoard(b).ok).toBe(false);
    expect(validateBoard({ schema: 1, generatedAt: "x", days: 90, repos: [] }).ok).toBe(false);
  });
});

describe("writeAtomic (#8)", () => {
  it("replaces the file and leaves no temporary files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-"));
    const f = join(dir, "a.json");
    writeAtomic(f, "1");
    writeAtomic(f, "2");
    expect(readFileSync(f, "utf8")).toBe("2");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });
  it("keeps the old file when the write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-"));
    const f = join(dir, "a.json");
    writeAtomic(f, "old");
    expect(() => writeAtomic(f, { bad: true } as unknown as string)).toThrow();
    expect(readFileSync(f, "utf8")).toBe("old");
  });
});

describe("crawler with damaged data (#8)", () => {
  it("quarantines an invalid report, keeps valid ones and writes a valid board", () => {
    const data = mkdtempSync(join(tmpdir(), "hm-data-"));
    const rawDir = mkdtempSync(join(tmpdir(), "hm-raw-"));
    mkdirSync(join(rawDir, "o"), { recursive: true });
    writeFileSync(join(rawDir, "o", "r.json"), JSON.stringify(raw));
    writeFileSync(join(rawDir, "o", "broken.json"), "{not json");
    writeFileSync(join(data, "repos.json"), JSON.stringify({ generatedAt: new Date().toISOString(), top: ["o/r", "x/y"] }));
    mkdirSync(join(data, "data/repos/x"), { recursive: true });
    const bad = clone(good);
    bad.repo.fullName = "x/y";
    bad.commits.ai = 99;
    writeFileSync(join(data, "data/repos/x/y.json"), JSON.stringify(bad));
    const out = execFileSync("npx", ["tsx", "scripts/crawl.ts", "--data", data, "--raw", rawDir, "--reclassify"], { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } });
    expect(out).toContain("skip unreadable raw file");
    expect(out).toContain("quarantined data/repos/x/y.json");
    expect(existsSync(join(data, "data/repos/x/y.json"))).toBe(false);
    const board = JSON.parse(readFileSync(join(data, "data/leaderboard.json"), "utf8"));
    expect(validateBoard(board).ok).toBe(true);
    expect(board.repos.map((e: any) => e.fullName)).toEqual(["o/r"]);
    expect(board.cohort.missing).toBe(1);
  }, 30_000);
});

describe("nested validation (round 2, #28)", () => {
  it("rejects a month bucket without byAgent", () => {
    const r = clone(good);
    delete (r.commits.byMonth[0] as any).byAgent;
    expect(validateReport(r).ok).toBe(false);
  });
  it("rejects a board entry without byAgent or with a bad share", () => {
    const board = buildBoard([toEntry(good)], ["o/r"], [], "2026-11-01T00:00:00Z", 90, new Date("2026-11-02T00:00:00Z"));
    const a = clone(board);
    delete (a.repos[0] as any).byAgent;
    expect(validateBoard(a).ok).toBe(false);
    const b = clone(board);
    (b.repos[0] as any).share = 7;
    expect(validateBoard(b).ok).toBe(false);
  });
  it("rejects raw data with null or malformed items", async () => {
    const { validateRepoData } = await import("../src/core/validate");
    expect(validateRepoData({ ...clone(raw), commits: { items: [null], capped: false } }).ok).toBe(false);
    expect(validateRepoData({ ...clone(raw), pulls: { items: [{ number: "1" }], capped: false } }).ok).toBe(false);
    expect(validateRepoData(clone(raw)).ok).toBe(true);
  });
});

describe("tracking files and old reports (round 2, #31)", () => {
  it("reads tracked/<owner>/<repo>.json, keeps tracked repos in their own cohort and assembles despite old reports", () => {
    const data = mkdtempSync(join(tmpdir(), "hm-data-"));
    const rawDir = mkdtempSync(join(tmpdir(), "hm-raw-"));
    mkdirSync(join(rawDir, "o"), { recursive: true });
    writeFileSync(join(rawDir, "o", "r.json"), JSON.stringify(raw));
    const req = clone(raw);
    req.repo.fullName = "small/thing";
    req.repo.url = "https://github.com/small/thing";
    mkdirSync(join(rawDir, "small"), { recursive: true });
    writeFileSync(join(rawDir, "small", "thing.json"), JSON.stringify(req));
    writeFileSync(join(data, "repos.json"), JSON.stringify({ generatedAt: new Date().toISOString(), top: ["o/r"] }));
    mkdirSync(join(data, "tracked/small"), { recursive: true });
    writeFileSync(join(data, "tracked/small/thing.json"), JSON.stringify({ repo: "small/thing", requestedAt: "2026-11-02T00:00:00Z" }));
    // an old-schema report for a repo that is no longer listed
    mkdirSync(join(data, "data/repos/gone"), { recursive: true });
    writeFileSync(join(data, "data/repos/gone/away.json"), JSON.stringify({ ...clone(good), schema: 1, repo: { ...good.repo, fullName: "gone/away" } }));
    const out = execFileSync("npx", ["tsx", "scripts/crawl.ts", "--data", data, "--raw", rawDir, "--reclassify"], { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } });
    expect(out).toContain("quarantined data/repos/gone/away.json");
    const board = JSON.parse(readFileSync(join(data, "data/leaderboard.json"), "utf8"));
    expect(board.repos.map((e: any) => `${e.fullName}:${e.cohort}`).sort()).toEqual(["o/r:top", "small/thing:tracked"]);
    // assemble skips (does not fail on) an old-schema report that is still listed
    writeFileSync(join(data, "data/repos/o/r.json"), JSON.stringify({ ...clone(good), schema: 1 }));
    const site = mkdtempSync(join(tmpdir(), "hm-site-"));
    writeFileSync(join(site, "index.html"), "<html><head><title>x</title></head><body></body></html>");
    const asm = execFileSync("npx", ["tsx", "scripts/assemble.ts", "--site", site, "--data", data, "--no-og"], { encoding: "utf8" });
    expect(asm).toContain("skipping 1 reports of an older schema");
  }, 60_000);
});
