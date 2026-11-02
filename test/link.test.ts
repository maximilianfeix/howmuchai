import { describe, expect, it } from "vitest";
import { buildReport, linkedPull, pullIndex, type RepoData } from "../src/core/analyze";
import type { CommitInput, PullInput } from "../src/core/types";

const commit = (sha: string, message: string, date = "2026-10-10T12:00:00Z"): CommitInput => ({ sha, message, date, url: `https://github.com/o/r/commit/${sha}`, authorLogin: "dev", parents: 1 });
const pull = (number: number, body: string, extra: Partial<PullInput> = {}): PullInput => ({
  number,
  title: `PR ${number}`,
  body,
  authorLogin: "dev",
  branch: "feature",
  createdAt: "2026-10-09T00:00:00Z",
  mergedAt: "2026-10-10T12:00:05Z",
  url: `https://github.com/o/r/pull/${number}`,
  ...extra,
});
const FOOTER = "Adds the thing.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
function data(commits: CommitInput[], pulls: PullInput[]): RepoData {
  return {
    repo: { fullName: "o/r", url: "https://github.com/o/r", description: null, stars: 1, defaultBranch: "main", language: null, archived: false, fork: false },
    commits: { items: commits, capped: false },
    pulls: { items: pulls, capped: false },
    baseline: [],
    setup: [],
    since: "2026-08-04T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    days: 90,
  };
}

describe("squash commits inherit the signature of their pull request", () => {
  it("counts a squash commit whose merged PR carries a signature, with the PR in the evidence", () => {
    const r = buildReport(data([commit("aaaaaaa1", "Add the thing (#12)"), commit("bbbbbbb2", "Unrelated fix")], [pull(12, FOOTER)]));
    expect(r.commits.ai).toBe(1);
    expect(r.commits.byAgent["claude-code"]).toBe(1);
    expect(r.commits.evidence[0]!.viaPull).toBe(12);
    expect(r.commits.evidence[0]!.matched).toMatch(/^PR #12: /);
  });

  it("needs the merge sha to match when GitHub gives one", () => {
    const p = pull(12, FOOTER, { mergeCommitSha: "ffffffff" });
    expect(linkedPull(commit("aaaaaaa1", "Add the thing (#12)"), pullIndex([p]))).toBeNull();
    expect(linkedPull(commit("ffffffff", "Add the thing (#12)"), pullIndex([p]))?.number).toBe(12);
  });

  it("does not link to an unmerged PR, a PR merged long before, a number in the body, or a missing PR", () => {
    const prs = pullIndex([pull(12, FOOTER, { mergedAt: null }), pull(13, FOOTER, { mergedAt: "2026-09-01T00:00:00Z" }), pull(14, FOOTER)]);
    expect(linkedPull(commit("a", "Add (#12)"), prs)).toBeNull();
    expect(linkedPull(commit("b", "Add (#13)"), prs)).toBeNull();
    expect(linkedPull(commit("c", "Add the thing\n\nsee (#14)"), prs)).toBeNull();
    expect(linkedPull(commit("d", "Add (#99)"), prs)).toBeNull();
    expect(linkedPull(commit("e", "Revert \"Add (#14)\" and more"), prs)).toBeNull();
  });

  it("keeps the commit's own signature when it has one", () => {
    const r = buildReport(data([commit("aaaaaaa1", "Add (#12)\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>")], [pull(12, FOOTER)]));
    expect(r.commits.byAgent).toEqual({ copilot: 1 });
    expect(r.commits.evidence[0]!.viaPull).toBeUndefined();
  });

  it("does not use PR hints (medium confidence) to count a commit", () => {
    const r = buildReport(data([commit("aaaaaaa1", "Add (#12)")], [pull(12, "plain body", { branch: "codex/add-thing" })]));
    expect(r.commits.ai).toBe(0);
  });
});
