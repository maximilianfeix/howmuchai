import { describe, expect, it } from "vitest";
import { buildReport, type RepoData } from "../src/core/analyze";
import { buildBoard, likelyBadgePath, toEntry } from "../src/core/dataset";
import { formatRange, noEstimateReason } from "../src/core/format";
import { likelyValue, renderCard, renderLikelyBadge } from "../src/core/render";
import { validateBoard } from "../src/core/validate";

const agentMsg = (i: number) =>
  `fix(parser): handle empty option values without crashing the sender ${i}\n\nThe replication protocol allows options without values, but the parser read the argument directly. This change reads both options through the helper, which reports a missing value cleanly and keeps the old behaviour otherwise.\n\n- read proto_version and publication_names through defGetString()\n- add a regression test for both options`;
const humanMsg = (i: number) => (i % 2 ? `Fix tokenizer off by one ${i}\n\nhappens when the input ends early, found by fuzzing` : `Bump lockfile ${i}\n\ndrop the old node 18 workaround while at it`);
function data(signed: number, undisclosed: number, human: number, baseline: number): RepoData {
  const items: RepoData["commits"]["items"] = [];
  let n = 0;
  const push = (message: string, author = "dev") => items.push({ sha: `s${n}`, message, date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/s${n++}`, authorLogin: author, parents: 1 });
  for (let i = 0; i < signed; i++) push(`${agentMsg(i)}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
  for (let i = 0; i < undisclosed; i++) push(agentMsg(100 + i));
  for (let i = 0; i < human; i++) push(humanMsg(i), "other");
  return {
    repo: { fullName: "O/R", url: "https://github.com/O/R", description: null, stars: 1, defaultBranch: "main", language: null, archived: false, fork: false },
    commits: { items, capped: false },
    pulls: { items: [], capped: false },
    baseline: Array.from({ length: baseline }, (_, i) => ({ sha: `b${i}`, message: humanMsg(i), date: "2021-01-01T00:00:00Z", url: `https://github.com/o/r/commit/b${i}`, parents: 1 })),
    setup: [],
    since: "2026-08-04T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    days: 90,
  };
}

describe("likely range on badges, cards and the leaderboard", () => {
  it("formats ranges", () => {
    expect(formatRange(0.451, 0.68)).toBe("45–68%");
    expect(formatRange(0.62, 0.621)).toBe("62%");
    expect(formatRange(0, 1)).toBe("0–100%");
  });

  it("shows the estimated range when there is one", () => {
    const r = buildReport(data(20, 60, 20, 60));
    const l = r.beyond!.likely!;
    expect(likelyValue(r)).toBe(formatRange(l.lo, l.hi));
    const svg = renderLikelyBadge(r);
    expect(svg).toContain("AI likely");
    expect(svg).toContain(formatRange(l.lo, l.hi));
    expect(svg).toContain("experimental estimate");
    expect(renderCard(r)).toContain(`Estimated likely ${formatRange(l.lo, l.hi)} (experimental)`);
  });

  it("falls back to the disclosed share as a lower bound without an estimate", () => {
    const r = buildReport(data(5, 60, 35, 60));
    expect(r.beyond!.likely).toBeNull();
    expect(likelyValue(r)).toBe("≥5%");
    expect(renderLikelyBadge(r)).toContain("no estimate beyond that");
    expect(renderCard(r)).toContain("Disclosed signatures; a lower bound.");
  });

  it("shows a dash for a repo without commits", () => {
    const r = buildReport(data(0, 0, 0, 0));
    expect(likelyValue(r)).toBe("—");
  });

  it("puts the likely badge under its own directory so no repo name can collide with it", () => {
    expect(likelyBadgePath("O/R")).toBe("badge/likely/o/r.svg");
  });

  it("carries the range into leaderboard entries and validates it", () => {
    const r = buildReport(data(20, 60, 20, 60));
    const e = toEntry(r);
    expect(e.likely).toEqual(r.beyond!.likely);
    const b = buildBoard([e], ["O/R"], [], "2026-11-01T00:00:00Z", 90, new Date("2026-11-02T00:00:00Z"));
    expect(validateBoard(b).ok).toBe(true);
    const bad = { ...b, repos: [{ ...b.repos[0], likely: { lo: 0.7, point: 0.5, hi: 0.9 } }] };
    expect(validateBoard(bad).ok).toBe(false);
    const old = { ...b, repos: [{ ...b.repos[0], likely: undefined }] };
    expect(validateBoard(old).ok).toBe(true);
  });

  it("explains every refusal reason in words", () => {
    for (const reason of ["no-commits", "no-evidence", "setup-only", "too-few-disclosed", "too-little-history", "all-disclosed", "too-few-judgeable", "inseparable", "too-uncertain"])
      expect(noEstimateReason(reason)).not.toMatch(/^[a-z-]+$/);
    expect(noEstimateReason(undefined)).toBe(noEstimateReason("no-evidence"));
  });
});
