import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, type GroundTruthItem } from "../scripts/eval-lib";

const items = JSON.parse(readFileSync("eval/ground-truth.json", "utf8")) as GroundTruthItem[];

describe("ground truth (#4)", () => {
  const r = evaluate(items);
  it("has no false positives", () => expect(r.failures.filter((f) => f.problem.startsWith("counted"))).toEqual([]));
  it("never attributes to the wrong agent", () => expect(r.wrongAgent).toBe(0));
  it("misses no labelled signature", () => expect(r.failures.filter((f) => f.problem.startsWith("missed"))).toEqual([]));
  it("covers enough repositories", () => expect(new Set(items.map((i) => i.repo)).size).toBeGreaterThanOrEqual(20));

  it("fails when one false-positive label is introduced", () => {
    const sig = items.find((i) => i.label === "signature")!;
    const broken = items.map((i) => (i === sig ? { ...i, label: "none" as const, agent: null } : i));
    expect(evaluate(broken).fp).toBe(1);
  });
});
