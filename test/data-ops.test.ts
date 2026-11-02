import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFreshness } from "../scripts/freshness";

const PUSH = resolve("scripts/push-data.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hm-git-"));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "data", remote);
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-b", "data");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) git(seed, "config", k!, v!);
  writeFileSync(join(seed, "shared.json"), "{}\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "data");
  const clone = (name: string) => {
    const d = join(root, name);
    git(root, "clone", "-q", "-b", "data", remote, d);
    for (const [k, v] of [["user.name", name], ["user.email", `${name}@t`]]) git(d, "config", k!, v!);
    return d;
  };
  return { remote, clone };
}

describe("push-data.sh (#9)", () => {
  it("keeps both writers' changes when they race on different files", () => {
    const { remote, clone } = setup();
    const a = clone("crawler");
    const b = clone("tracker");
    writeFileSync(join(a, "report-a.json"), "1\n");
    writeFileSync(join(b, "tracked.json"), "2\n");
    execFileSync(PUSH, [a, "crawl"], { encoding: "utf8" });
    const out = execFileSync(PUSH, [b, "track"], { encoding: "utf8" });
    expect(out).toContain("rebasing");
    const files = git(remote, "ls-tree", "--name-only", "data");
    expect(files).toContain("report-a.json");
    expect(files).toContain("tracked.json");
  });

  it("fails instead of overwriting on a real conflict, and never force-pushes", () => {
    const { remote, clone } = setup();
    const a = clone("one");
    const b = clone("two");
    writeFileSync(join(a, "shared.json"), '{"a":1}\n');
    writeFileSync(join(b, "shared.json"), '{"b":2}\n');
    execFileSync(PUSH, [a, "one"]);
    const r = spawnSync(PUSH, [b, "two"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(git(remote, "show", "data:shared.json")).toBe('{"a":1}\n');
  });

  it("does nothing when there are no changes", () => {
    const { clone } = setup();
    expect(execFileSync(PUSH, [clone("idle"), "noop"], { encoding: "utf8" })).toContain("no data changes");
  });

  it("never uses --force", () => {
    expect(readFileSync(PUSH, "utf8")).not.toMatch(/--force|\s-f\s|\+HEAD/);
  });
});

describe("freshness (#9)", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const entry = (name: string, measuredAt: string) => ({
    fullName: name, stars: 1, language: null, share: 0, ai: 0, total: 1, prAi: 0, prTotal: 0, top: null, byAgent: {}, capped: false, oldest: null, measuredAt, cohort: "top",
  });
  const board = (generatedAt: string, measured: string[], selected = measured.length) => ({
    schema: 1, generatedAt, days: 90,
    cohort: { selectedAt: generatedAt, selected, measured: measured.length, missing: selected - measured.length, capped: 0, stale: 0, oldestMeasurement: null },
    repos: measured.map((m, i) => entry(`o/r${i}`, m)),
  });
  const fresh = "2026-11-03T10:00:00Z";
  it("passes a fresh, complete board", () => expect(checkFreshness(board(fresh, [fresh, fresh]), now).ok).toBe(true));
  it("fails an old board", () => expect(checkFreshness(board("2026-11-01T00:00:00Z", [fresh]), now).problems[0]).toMatch(/h old/));
  it("fails a freshly assembled board with stale rows", () => {
    const r = checkFreshness(board(fresh, Array.from({ length: 10 }, (_, i) => (i < 3 ? "2026-10-30T00:00:00Z" : fresh))), now);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/older than 48 h/);
  });
  it("fails when too few selected repos are measured", () => expect(checkFreshness(board(fresh, [fresh], 10), now).ok).toBe(false));
  it("fails an invalid or empty board", () => {
    expect(checkFreshness({ nope: 1 }, now).ok).toBe(false);
    expect(checkFreshness(board(fresh, []), now).ok).toBe(false);
  });
});
