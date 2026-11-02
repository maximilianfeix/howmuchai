import { describe, expect, it } from "vitest";
import { buildReport, parseRepo, type RepoData } from "../src/core/analyze";
import { createClassifier } from "../src/core/classify";
import { formatShare } from "../src/core/format";
import { registry } from "../src/core/registry";
import { renderBadge, renderCard, renderOg } from "../src/core/render";
import type { CommitInput, PullInput } from "../src/core/types";

const cls = createClassifier(registry);

function commit(over: Partial<CommitInput>): CommitInput {
  return {
    sha: "abcdef1234567890",
    message: "fix: something",
    date: "2026-10-20T10:00:00Z",
    url: "https://github.com/o/r/commit/abcdef1",
    authorName: "Jane Doe",
    authorEmail: "jane@example.com",
    authorLogin: "jane",
    committerName: "GitHub",
    committerEmail: "noreply@github.com",
    committerLogin: "web-flow",
    parents: 1,
    ...over,
  };
}

function pull(over: Partial<PullInput>): PullInput {
  return {
    number: 1,
    title: "Add thing",
    body: "",
    authorLogin: "jane",
    branch: "feature/thing",
    createdAt: "2026-10-20T10:00:00Z",
    mergedAt: null,
    url: "https://github.com/o/r/pull/1",
    ...over,
  };
}

const ids = (c: CommitInput) => cls.commit(c).map((m) => m.agentId);

const data: RepoData = {
  repo: { fullName: "o/r", url: "https://github.com/o/r", description: "<b>x</b> & y", stars: 10, defaultBranch: "main", language: "Go", archived: false, fork: false },
  commits: {
    items: [
      commit({ sha: "1111111", message: "a\n\nCo-Authored-By: Claude <noreply@anthropic.com>", date: "2026-09-02T00:00:00Z" }),
      commit({ sha: "2222222", message: "b", date: "2026-10-02T00:00:00Z" }),
      commit({ sha: "3333333", message: "Merge pull request #1", parents: 2 }),
      commit({ sha: "4444444", message: "bump", authorLogin: "dependabot[bot]" }),
    ],
    capped: false,
  },
  pulls: { items: [pull({ authorLogin: "Copilot" }), pull({ number: 2 })], capped: false },
  since: "2026-08-04T00:00:00Z",
  until: "2026-11-02T00:00:00Z",
  days: 90,
};

describe("commits", () => {
  it("finds the Claude Code trailer, also with a model name", () => {
    expect(ids(commit({ message: "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }))).toEqual(["claude-code"]);
    expect(ids(commit({ message: "fix\n\nCo-authored-by: Claude Opus 4.5 <noreply@anthropic.com>" }))).toEqual(["claude-code"]);
  });

  it("finds the Claude Code footer", () => {
    expect(ids(commit({ message: "fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" }))).toEqual(["claude-code"]);
  });

  it("does not count a human called Claude", () => {
    expect(ids(commit({ message: "fix\n\nCo-authored-by: Claude Monet <claude@monet.fr>" }))).toEqual([]);
    expect(ids(commit({ authorName: "Claude Dubois", authorLogin: "claudedubois" }))).toEqual([]);
  });

  it("does not count a trailer that is only quoted in the middle of a line", () => {
    expect(ids(commit({ message: "docs: explain why we strip Co-authored-by: Claude <noreply@anthropic.com> lines" }))).toEqual([]);
  });

  it("finds the Copilot co-author trailer and the coding agent", () => {
    expect(ids(commit({ message: "x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>" }))).toEqual(["copilot"]);
    expect(ids(commit({ authorLogin: "Copilot", authorName: "copilot-swe-agent[bot]" }))).toEqual(["copilot"]);
  });

  it("finds Aider, Devin, Jules and Cursor authors", () => {
    expect(ids(commit({ authorName: "Jane Doe (aider)" }))).toEqual(["aider"]);
    expect(ids(commit({ authorLogin: "devin-ai-integration[bot]" }))).toEqual(["devin"]);
    expect(ids(commit({ authorLogin: "google-labs-jules[bot]" }))).toEqual(["jules"]);
    expect(ids(commit({ message: "x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>" }))).toEqual(["cursor"]);
  });

  it("attributes a commit once even with two signatures", () => {
    const m = cls.commit(commit({ message: "x\n\nGenerated with Claude Code\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }));
    expect(m.map((x) => x.agentId)).toEqual(["claude-code"]);
  });

  it("leaves out merges and dependency bots", () => {
    expect(cls.isIgnoredCommit(commit({ parents: 2 }))).toBe(true);
    expect(cls.isIgnoredCommit(commit({ authorLogin: "dependabot[bot]" }))).toBe(true);
    expect(cls.isIgnoredCommit(commit({ authorLogin: "renovate[bot]" }))).toBe(true);
    expect(cls.isIgnoredCommit(commit({}))).toBe(false);
  });
});

describe("pull requests", () => {
  const pid = (p: PullInput) => cls.pull(p).map((m) => m.agentId);
  it("finds agent authors, footers and branches", () => {
    expect(pid(pull({ authorLogin: "Copilot" }))).toEqual(["copilot"]);
    expect(pid(pull({ authorLogin: "devin-ai-integration[bot]" }))).toEqual(["devin"]);
    expect(pid(pull({ body: "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" }))).toEqual(["claude-code"]);
    expect(pid(pull({ branch: "codex/fix-the-thing" }))).toEqual(["codex"]);
    expect(pid(pull({ branch: "cursor/fix-the-thing-1a2b" }))).toEqual(["cursor"]);
  });
  it("ignores ordinary pull requests", () => {
    expect(pid(pull({}))).toEqual([]);
    expect(pid(pull({ branch: "feature/codex-support" }))).toEqual([]);
  });
});

describe("parseRepo", () => {
  it("accepts names and URLs", () => {
    expect(parseRepo("vercel/next.js")).toBe("vercel/next.js");
    expect(parseRepo("https://github.com/vercel/next.js")).toBe("vercel/next.js");
    expect(parseRepo("github.com/vercel/next.js/tree/canary/packages")).toBe("vercel/next.js");
    expect(parseRepo("https://github.com/oven-sh/bun.git")).toBe("oven-sh/bun");
    expect(parseRepo("  astral-sh/uv/  ")).toBe("astral-sh/uv");
  });
  it("rejects junk", () => {
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("just-a-name")).toBeNull();
    expect(parseRepo("a/..")).toBeNull();
    expect(parseRepo("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("formatShare", () => {
  it("formats", () => {
    expect(formatShare(0, 0)).toBe("—");
    expect(formatShare(0, 10)).toBe("0%");
    expect(formatShare(1, 2000)).toBe("<0.1%");
    expect(formatShare(21, 500)).toBe("4.2%");
    expect(formatShare(2, 100)).toBe("2%");
    expect(formatShare(376, 424)).toBe("89%");
  });
});

describe("report", () => {
  const r = buildReport(data);

  it("counts commits and pull requests", () => {
    expect(r.commits.total).toBe(2);
    expect(r.commits.ai).toBe(1);
    expect(r.commits.byAgent).toEqual({ "claude-code": 1 });
    expect(r.share).toBe(0.5);
    expect(r.pulls.ai).toBe(1);
    expect(r.commits.byMonth.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(r.commits.evidence[0]?.ref).toBe("1111111");
  });

  it("renders SVGs with escaped text", () => {
    for (const svg of [renderCard(r, "dark"), renderCard(r, "light"), renderBadge(r), renderBadge(null), renderOg(r)]) {
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/<b>/);
      expect(svg).toContain("</svg>");
    }
    expect(renderBadge(r)).toContain("50%");
  });
});

describe("signatures found in real repos (registry v2)", () => {
  it("finds Codex CLI trailers without an OpenAI address", () => {
    expect(ids(commit({ message: "x\n\nCo-authored-by: gpt-6-astra (Codex) <agent@example.invalid>" }))).toEqual(["codex"]);
    expect(ids(commit({ message: "x\n\nCo-authored-by: Codex <noreply@openai.com>" }))).toEqual(["codex"]);
  });
  it("finds the short Cursor trailer", () => {
    expect(ids(commit({ message: "x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>" }))).toEqual(["cursor"]);
  });
  it("finds Claude Code on the web and agent apps", () => {
    expect(ids(commit({ authorLogin: "claude", authorName: "Claude", authorEmail: "noreply@anthropic.com" }))).toEqual(["claude-code"]);
    expect(ids(commit({ authorLogin: "opencode-agent[bot]" }))).toEqual(["opencode"]);
    expect(ids(commit({ message: "x\n\nCo-authored-by: capy-ai[bot] <123+capy-ai[bot]@users.noreply.github.com>" }))).toEqual(["capy"]);
  });
  it("does not count a person whose name contains codex", () => {
    expect(ids(commit({ authorName: "Codexia Smith", authorLogin: "codexia" }))).toEqual([]);
  });
});

describe("attribution precedence (#2)", () => {
  it("follows registry order, not the order of signal kinds", () => {
    const m = cls.commit(commit({ message: "x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>\n\nGenerated with Claude Code" }));
    expect(m.map((x) => x.agentId)).toEqual(["claude-code", "copilot"]);
  });
  it("prefers a high-confidence agent over a medium-confidence hint", () => {
    const m = cls.pull(pull({ authorLogin: "Copilot", branch: "claude/x" }));
    expect(m.map((x) => x.agentId)).toEqual(["copilot", "claude-code"]);
  });
  it("keeps the strongest evidence within one agent", () => {
    const m = cls.pull(pull({ branch: "codex/x", authorLogin: "chatgpt-codex-connector[bot]" }));
    expect(m).toHaveLength(1);
    expect(m[0]?.confidence).toBe("high");
  });
  it("makes agent totals add up to the AI total", () => {
    const items = [
      commit({ sha: "1", message: "a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Cursor <cursoragent@cursor.com>" }),
      commit({ sha: "2", message: "b\n\nCo-authored-by: Codex <noreply@openai.com>" }),
      commit({ sha: "3", message: "c" }),
    ];
    const r = buildReport({ ...data, commits: { items, capped: false } });
    const sum = Object.values(r.commits.byAgent).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.commits.ai);
    expect(r.commits.byAgent).toEqual({ "claude-code": 1, codex: 1 });
  });
});

describe("hints (#3)", () => {
  it("does not count a human PR on a codex/ branch, but lists it as a hint", () => {
    const r = buildReport({ ...data, pulls: { items: [pull({ branch: "codex/example" }), pull({ number: 2 })], capped: false } });
    expect(r.pulls.ai).toBe(0);
    expect(r.pulls.hints).toBe(1);
    expect(r.pulls.hintsByAgent).toEqual({ codex: 1 });
    expect(r.pulls.evidence[0]?.confidence).toBe("medium");
  });
  it("counts an item once when a hint and a signature agree", () => {
    const r = buildReport({ ...data, pulls: { items: [pull({ branch: "codex/x", authorLogin: "chatgpt-codex-connector[bot]" })], capped: false } });
    expect(r.pulls.ai).toBe(1);
    expect(r.pulls.hints).toBe(0);
  });
  it("marks reports with the current schema", () => {
    expect(buildReport(data).schema).toBe(2);
  });
});

describe("coverage labels (#5)", () => {
  it("says when the window was read completely, capped or empty", async () => {
    const { coverageLabel } = await import("../src/core/render");
    const r = buildReport(data);
    expect(coverageLabel(r.commits, r, "commits")).toBe("2 commits, last 90 days");
    const capped = { ...r.commits, capped: true, oldest: "2026-10-28T00:00:00Z" };
    expect(coverageLabel(capped, r, "commits")).toBe("newest 2 commits, since 2026-10-28");
    const empty = { ...r.commits, total: 0 };
    expect(coverageLabel(empty, r, "pull requests")).toBe("no pull requests in the last 90 days");
    expect(r.commits.fetched).toBe(4);
  });
});

describe("median (round 2, #29)", () => {
  it("averages the middle values of an even list", async () => {
    const { median } = await import("../src/core/format");
    expect(median([0, 1])).toBe(0.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

describe("dependency bots under other app names", () => {
  it("are left out", () => {
    expect(cls.isIgnoredCommit(commit({ authorLogin: "renovate-sh-app[bot]" }))).toBe(true);
    expect(cls.isIgnoredCommit(commit({ authorLogin: "dependabot-preview[bot]" }))).toBe(true);
    expect(cls.isIgnoredPull(pull({ authorLogin: "renovate-sh-app[bot]" }))).toBe(true);
    expect(cls.isIgnoredCommit(commit({ authorLogin: "renovatio" }))).toBe(false);
  });
});
