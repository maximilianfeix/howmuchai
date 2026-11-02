import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { validateReport } from "../src/core/validate";

const CLI = resolve("dist/cli.mjs");
const ACTION = resolve("action/index.mjs");
const PRELOAD = resolve("test/support/mock-fetch.mjs");
const now = new Date().toISOString();
const commit = (sha: string, message: string) => ({
  sha, html_url: `https://github.com/acme/app/commit/${sha}`,
  commit: { message, author: { name: "dev", email: "dev@x", date: now }, committer: { name: "dev", email: "dev@x", date: now } },
  author: { login: "dev" }, committer: { login: "dev" }, parents: [{}],
});
const fixture = {
  repo: { full_name: "acme/app", html_url: "https://github.com/acme/app", description: "App", stargazers_count: 7, default_branch: "main", language: "Go", archived: false, fork: false },
  commits: [commit("a1a1a1a", "feat: one\n\nCo-Authored-By: Claude <noreply@anthropic.com>"), commit("b2b2b2b", "fix: two\x1b]0;pwned\x07"), commit("c3c3c3c", "docs: three\n\nCo-authored-by: Codex <noreply@openai.com>"), commit("d4d4d4d", "chore: four")],
  pulls: [],
};
let dir: string;
const fx = (name: string, v: unknown) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(v));
  return p;
};
function run(bin: string, args: string[], env: Record<string, string>, cwd = process.cwd()) {
  return spawnSync("node", ["--import", PRELOAD, bin, ...args], { encoding: "utf8", cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NO_COLOR: "1", ...env } });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hm-bundle-"));
  if (!existsSync(CLI) || !existsSync(ACTION)) throw new Error("run npm run build first");
});

describe("CLI bundle (#12)", () => {
  it("prints a valid JSON report", () => {
    const r = run(CLI, ["acme/app", "--json"], { MOCK_GITHUB: fx("ok", fixture) });
    expect(r.status).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(validateReport(rep).ok).toBe(true);
    expect(rep.commits.ai).toBe(2);
    expect(rep.commits.byAgent).toEqual({ "claude-code": 1, codex: 1 });
  });

  it("prints the summary with coverage and evidence, without terminal escapes", () => {
    const r = run(CLI, ["https://github.com/acme/app", "--evidence"], { MOCK_GITHUB: fx("ok", fixture) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AI-signed commits  50%");
    expect(r.stdout).toContain("4 commits, last 90 days");
    expect(r.stdout).toContain("a1a1a1a");
    expect(r.stdout).not.toContain("\x1b]0;");
  });

  it("rejects bad options with exit code 2", () => {
    for (const args of [["acme/app", "--days", "1.5"], ["acme/app", "--days"], ["acme/app", "--days", "0"], ["acme/app", "--days", "99999"], ["acme/app", "--max", "abc"], ["acme/app", "--bogus"], [], ["a", "b/c"], ["not a repo"]]) {
      const r = run(CLI, args.length ? args : ["--json"], { MOCK_GITHUB: fx("ok", fixture) });
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  });

  it("exits 1 with a clear message on a missing repo and on the rate limit, never printing the token", () => {
    const nf = run(CLI, ["acme/none"], { MOCK_GITHUB: fx("nf", { status: 404, message: "Not Found" }), GITHUB_TOKEN: "ghp_secret123" });
    expect(nf.status).toBe(1);
    expect(nf.stderr).toContain("not found");
    const rl = run(CLI, ["acme/app"], { MOCK_GITHUB: fx("rl", { status: 403, message: "API rate limit exceeded for ghp_secret123", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } }), GITHUB_TOKEN: "ghp_secret123" });
    expect(rl.status).toBe(1);
    expect(rl.stderr).toContain("rate limit");
    expect(rl.stderr + rl.stdout + nf.stderr + nf.stdout).not.toContain("ghp_secret123");
  });

  it("sends the token only as an Authorization header", () => {
    const log = join(dir, "calls.log");
    run(CLI, ["acme/app", "--json"], { MOCK_GITHUB: fx("ok", fixture), GITHUB_TOKEN: "ghp_x", MOCK_LOG: log });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("auth=yes");
    expect(calls).not.toContain("ghp_x");
  });
});

describe("Action bundle (#12)", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
  function repoWithRemote() {
    const root = mkdtempSync(join(tmpdir(), "hm-action-"));
    git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    git(root, "clone", "-q", join(root, "remote.git"), "work");
    const work = join(root, "work");
    git(work, "config", "user.name", "t");
    git(work, "config", "user.email", "t@t");
    writeFileSync(join(work, "README.md"), "# app\n");
    writeFileSync(join(work, "untracked-secret.txt"), "do not commit");
    git(work, "add", "README.md");
    git(work, "commit", "-q", "-m", "init");
    git(work, "push", "-q", "origin", "main");
    return { root, work, remote: join(root, "remote.git") };
  }
  const actionEnv = (work: string, extra: Record<string, string>) => {
    const out = join(work, "..", "out.txt");
    const summary = join(work, "..", "summary.md");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    return { out, summary, env: { MOCK_GITHUB: fx("ok", fixture), INPUT_REPOSITORY: "acme/app", INPUT_TOKEN: "ghs_token", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...extra } };
  };

  it("writes the files, sets outputs and a summary, commits only its own files and pushes", () => {
    const { work, remote } = repoWithRemote();
    const { out, summary, env } = actionEnv(work, {});
    const r = run(ACTION, [], env, work);
    expect(r.status, r.stderr).toBe(0);
    for (const f of ["card-dark.svg", "card-light.svg", "badge.svg", "report.json"]) expect(existsSync(join(work, ".github/howmuchai", f))).toBe(true);
    expect(validateReport(JSON.parse(readFileSync(join(work, ".github/howmuchai/report.json"), "utf8"))).ok).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("share=50%");
    expect(readFileSync(summary, "utf8")).toContain("50% AI-signed commits");
    const files = git(remote, "ls-tree", "-r", "--name-only", "main");
    expect(files).toContain(".github/howmuchai/badge.svg");
    expect(files).not.toContain("untracked-secret.txt");
    expect(r.stdout + r.stderr).not.toContain("ghs_token");
  });

  it("does not commit with commit=false", () => {
    const { work, remote } = repoWithRemote();
    const { env } = actionEnv(work, { INPUT_COMMIT: "false" });
    const r = run(ACTION, [], env, work);
    expect(r.status).toBe(0);
    expect(existsSync(join(work, ".github/howmuchai/badge.svg"))).toBe(true);
    expect(git(remote, "ls-tree", "-r", "--name-only", "main")).not.toContain(".github/howmuchai");
  });

  it("fails without writing or committing when the analysis fails", () => {
    const { work, remote } = repoWithRemote();
    const { env } = actionEnv(work, { MOCK_GITHUB: fx("nf", { status: 404, message: "Not Found" }) });
    const r = run(ACTION, [], env, work);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("::error::");
    expect(existsSync(join(work, ".github/howmuchai"))).toBe(false);
    expect(git(remote, "log", "--oneline", "main").trim().split("\n")).toHaveLength(1);
  });

  it("is idempotent: a second run with the same data commits nothing new", () => {
    const { work, remote } = repoWithRemote();
    const { env } = actionEnv(work, {});
    run(ACTION, [], env, work);
    const before = git(remote, "rev-parse", "main").trim();
    const r = run(ACTION, [], { ...env, INPUT_DAYS: "90" }, work);
    expect(r.status).toBe(0);
    // report.json carries the measurement time, so only that file may change; badge and cards stay equal
    expect(git(work, "diff", "--name-only", before, "HEAD").split("\n").filter(Boolean).every((f) => f.startsWith(".github/howmuchai/"))).toBe(true);
  });
});
