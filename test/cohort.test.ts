import { describe, expect, it } from "vitest";
import { buildBoard, topCohort, type BoardEntry } from "../src/core/dataset";

const e = (fullName: string, stars: number, ai: number, measuredAt = "2026-11-02T00:00:00Z"): Omit<BoardEntry, "cohort"> => ({
  fullName, stars, language: null, share: ai / 100, ai, total: 100, prAi: 0, prTotal: 0, top: null, byAgent: {}, capped: false, oldest: null, measuredAt,
});
const now = new Date("2026-11-02T12:00:00Z");

describe("cohorts (#7)", () => {
  const top = ["big/one", "Big/Two", "big/three"];
  const base = [e("big/one", 1000, 10), e("big/two", 900, 20)];

  it("keeps tracked repos out of the top cohort and its statistics", () => {
    const without = buildBoard(base, top, [], "2026-11-01T00:00:00Z", 90, now);
    const withTracked = buildBoard([...base, e("tiny/repo", 0, 30)], top, ["tiny/repo"], "2026-11-01T00:00:00Z", 90, now);
    expect(topCohort(withTracked)).toEqual(topCohort(without));
    expect(withTracked.cohort).toEqual(without.cohort);
    expect(withTracked.repos.find((r) => r.fullName === "tiny/repo")?.cohort).toBe("tracked");
  });

  it("counts a repo that is both selected and tracked once, as top", () => {
    const b = buildBoard([...base, e("big/one", 1000, 10)], top, ["BIG/ONE"], "2026-11-01T00:00:00Z", 90, now);
    expect(b.repos.filter((r) => r.fullName === "big/one")).toHaveLength(1);
    expect(b.repos[0]?.cohort).toBe("top");
  });

  it("reports how complete the cohort is", () => {
    const b = buildBoard([...base, e("big/three", 800, 0, "2026-10-30T00:00:00Z")].slice(0, 3), top, [], "2026-11-01T00:00:00Z", 90, now);
    expect(b.cohort).toMatchObject({ selected: 3, measured: 3, missing: 0, stale: 1, oldestMeasurement: "2026-10-30T00:00:00Z" });
    const partial = buildBoard(base, top, [], "2026-11-01T00:00:00Z", 90, now);
    expect(partial.cohort).toMatchObject({ selected: 3, measured: 2, missing: 1 });
  });

  it("drops reports of repos that are neither selected nor tracked", () => {
    const b = buildBoard([...base, e("old/gone", 5, 1)], top, [], "2026-11-01T00:00:00Z", 90, now);
    expect(b.repos.map((r) => r.fullName)).not.toContain("old/gone");
  });
});
