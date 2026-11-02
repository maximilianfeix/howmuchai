import { describe, expect, it } from "vitest";
import { buildReport, GATE_DISCLOSED, type RepoData } from "../src/core/analyze";
import { prevalence } from "../src/core/estimate";
import { isJudgeable, stripSignatures } from "../src/core/style";
import { validateReport } from "../src/core/validate";

const agentMsg = (i: number) =>
  `fix(parser): handle empty option values without crashing the sender ${i}\n\nThe replication protocol allows options without values, but the parser read the argument directly. This change reads both options through the helper, which reports a missing value cleanly and keeps the old behaviour otherwise.\n\n- read proto_version and publication_names through defGetString()\n- add a regression test for both options`;
const humanMsg = (i: number) => (i % 2 ? `Fix tokenizer off by one ${i}\n\nhappens when the input ends early, found by fuzzing` : `Bump lockfile ${i}\n\ndrop the old node 18 workaround while at it`);
function data(opts: { signed: number; undisclosedAgentStyle: number; human: number; baseline?: number; setup?: { path: string; agentId: string }[] }): RepoData {
  const items: RepoData["commits"]["items"] = [];
  let n = 0;
  const push = (message: string, author = "dev") => items.push({ sha: `s${n}`, message, date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/s${n++}`, authorLogin: author, parents: 1 });
  for (let i = 0; i < opts.signed; i++) push(`${agentMsg(i)}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
  for (let i = 0; i < opts.undisclosedAgentStyle; i++) push(agentMsg(100 + i));
  for (let i = 0; i < opts.human; i++) push(humanMsg(i), "other");
  return {
    repo: { fullName: "o/r", url: "https://github.com/o/r", description: null, stars: 1, defaultBranch: "main", language: null, archived: false, fork: false },
    commits: { items, capped: false },
    pulls: { items: [], capped: false },
    baseline: opts.baseline ? Array.from({ length: opts.baseline }, (_, i) => ({ sha: `b${i}`, message: humanMsg(i), date: "2021-01-01T00:00:00Z", url: `https://github.com/o/r/commit/b${i}`, parents: 1 })) : [],
    setup: opts.setup ?? [],
    since: "2026-08-04T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    days: 90,
  };
}

describe("beyond signatures", () => {
  it("never estimates without evidence of agent use", () => {
    const r = buildReport(data({ signed: GATE_DISCLOSED - 1, undisclosedAgentStyle: 60, human: 20 }));
    expect(r.beyond?.estimate).toBeNull();
    expect(r.beyond?.likely).toBeNull();
    expect(r.beyond?.reason).toBe("no-evidence");
    expect(validateReport(r).ok).toBe(true);
  });

  it("estimates when the repo discloses agent use, with an ordered range above the disclosed share", () => {
    const r = buildReport(data({ signed: 20, undisclosedAgentStyle: 60, human: 20, baseline: 60 }));
    const e = r.beyond!.estimate!, l = r.beyond!.likely!;
    expect(e.gate).toBe("disclosed");
    expect(e.humanReference).toBe("own-history");
    expect(e.aiReference).toBe("repo");
    expect(e.lo).toBeLessThanOrEqual(e.point);
    expect(e.point).toBeLessThanOrEqual(e.hi);
    expect(l.lo).toBeGreaterThanOrEqual(r.share! - 1e-9);
    expect(e.point).toBeGreaterThan(0.5); // most undisclosed commits look like the disclosed ones
    expect(validateReport(r).ok).toBe(true);
  });

  it("estimates near zero when the undisclosed commits look like the repo's own history", () => {
    const r = buildReport(data({ signed: 20, undisclosedAgentStyle: 0, human: 80, baseline: 80 }));
    expect(r.beyond!.estimate!.point).toBeLessThan(0.1);
  });

  it("never estimates from agent setup files alone", () => {
    const r = buildReport(data({ signed: 0, undisclosedAgentStyle: 30, human: 30, setup: [{ path: "CLAUDE.md", agentId: "claude-code" }] }));
    expect(r.beyond!.estimate).toBeNull();
    expect(r.beyond!.reason).toBe("setup-only");
    expect(r.beyond!.setup).toEqual([{ path: "CLAUDE.md", agentId: "claude-code" }]);
  });
  it("never uses the training data as the agent reference", () => {
    const r = buildReport(data({ signed: 9, undisclosedAgentStyle: 30, human: 30 }));
    expect(r.beyond!.estimate).toBeNull();
  });
  it("refuses an old repo without enough own history, accepts a young one with none", () => {
    const old = data({ signed: 20, undisclosedAgentStyle: 30, human: 30 });
    old.baseline = Array.from({ length: 10 }, (_, i) => ({ sha: `b${i}`, message: "x", date: "2021-01-01T00:00:00Z", url: "https://github.com/o/r/commit/b", parents: 1 }));
    expect(buildReport(old).beyond!.reason).toBe("too-little-history");
    const young = data({ signed: 20, undisclosedAgentStyle: 30, human: 30 });
    young.baseline = [];
    expect(buildReport(young).beyond!.estimate!.humanReference).toBe("training");
  });

  it("counts commits by authors who disclose agent use", () => {
    const r = buildReport(data({ signed: 5, undisclosedAgentStyle: 15, human: 10 }));
    expect(r.beyond!.authors).toEqual({ aiAuthors: 1, authors: 2, commitsByAiAuthors: 20 });
  });

  it("never lets the signature itself into the style features", () => {
    expect(stripSignatures("x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe("x");
    expect(isJudgeable("Release 1.5.0")).toBe(false);
    expect(isJudgeable(agentMsg(1))).toBe(true);
  });
});

describe("uncertainty guard", () => {
  it("shows no estimate when the interval would be wider than half the scale", async () => {
    const { MAX_RANGE } = await import("../src/core/analyze");
    expect(MAX_RANGE).toBe(0.5);
  });
});

describe("prevalence", () => {
  it("recovers a known mix and is deterministic", () => {
    const S = [...Array(30).fill(0.9), ...Array(70).fill(0.1)];
    const a = prevalence(S, Array(50).fill(0.1), Array(50).fill(0.9))!;
    expect(a.point).toBeCloseTo(0.3, 5);
    expect(prevalence(S, Array(50).fill(0.1), Array(50).fill(0.9))).toEqual(a);
  });
  it("refuses when the references cannot be told apart, and clamps to 0..1", () => {
    expect(prevalence([0.5], 0.5, 0.55)).toBeNull();
    expect(prevalence([0.99, 0.99], 0.2, 0.8)!.point).toBe(1);
    expect(prevalence([0.01], 0.2, 0.8)!.point).toBe(0);
    expect(prevalence([], 0.2, 0.8)).toBeNull();
  });
});

describe("beyond signatures, review fixes", () => {
  it("treats too-short messages as unknown instead of human", () => {
    const d = data({ signed: 10, undisclosedAgentStyle: 0, human: 0 });
    for (let i = 0; i < 25; i++) d.commits.items.push({ sha: `t${i}`, message: "fix typo", date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/t${i}`, parents: 1 });
    const r = buildReport(d);
    expect(r.beyond!.estimate).toBeNull();
    expect(r.beyond!.reason).toBe("too-few-judgeable");
  });
  it("keeps short commits out of the low end but inside the high end of the range", () => {
    const d = data({ signed: 20, undisclosedAgentStyle: 40, human: 0, baseline: 60 });
    for (let i = 0; i < 40; i++) d.commits.items.push({ sha: `t${i}`, message: `v1.${i}`, date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/t${i}`, authorLogin: "dev", parents: 1 });
    const r = buildReport(d);
    const l = r.beyond!.likely!;
    expect(r.beyond!.estimate!.tooShort).toBe(40);
    expect(l.hi - l.lo).toBeGreaterThan(0.3);
  });
  it("merges a person's login and e-mail and leaves agent accounts out of the author metric", () => {
    const d = data({ signed: 5, undisclosedAgentStyle: 0, human: 0 });
    d.commits.items = d.commits.items.map((c) => ({ ...c, authorLogin: "alice", authorEmail: "alice@example.org" }));
    d.commits.items.push({ sha: "x1", message: "fix the parser\n\nfor empty values in options it crashed", date: "2026-10-10T00:00:00Z", url: "https://github.com/o/r/commit/x1", authorLogin: null, authorEmail: "alice@example.org", parents: 1 });
    d.commits.items.push({ sha: "x2", message: "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>", date: "2026-10-10T00:00:00Z", url: "https://github.com/o/r/commit/x2", authorLogin: "claude[bot]", parents: 1 });
    const r = buildReport(d);
    expect(r.beyond!.authors).toEqual({ aiAuthors: 1, authors: 1, commitsByAiAuthors: 6 });
  });
  it("survives a huge commit message", () => {
    const d = data({ signed: 0, undisclosedAgentStyle: 0, human: 1 });
    d.commits.items.push({ sha: "h", message: "subject\n" + "x\n".repeat(150_000), date: "2026-10-10T00:00:00Z", url: "https://github.com/o/r/commit/h", parents: 1 });
    expect(() => buildReport(d)).not.toThrow();
  });
  it("says why when every commit is disclosed", () => {
    const r = buildReport(data({ signed: 25, undisclosedAgentStyle: 0, human: 0 }));
    expect(r.beyond!.reason).toBe("all-disclosed");
  });
  it("strips the aider markers", () => {
    expect(stripSignatures("aider: fix typo (aider)")).toBe("fix typo");
  });
});
