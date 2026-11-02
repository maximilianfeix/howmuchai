import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { buildReport, type RepoData } from "../src/core/analyze";
import { renderOgPng } from "../scripts/lib/og";

const BASE = "test/og-baselines";
const OUT = "test-results/og";
const UPDATE = process.env.UPDATE_OG === "1";

function data(fullName: string, agents: [string, number][], total: number): RepoData {
  const trailer: Record<string, string> = {
    claude: "Co-Authored-By: Claude <noreply@anthropic.com>",
    copilot: "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
    codex: "Co-authored-by: Codex <noreply@openai.com>",
    cursor: "Co-authored-by: Cursor <cursoragent@cursor.com>",
  };
  const items: RepoData["commits"]["items"] = [];
  let i = 0;
  for (const [a, n] of agents) for (let k = 0; k < n; k++) items.push({ sha: `s${i}`, message: `m${i++}\n\n${trailer[a]}`, date: "2026-10-15T00:00:00Z", url: `https://github.com/${fullName}/commit/s${i}`, parents: 1 });
  while (items.length < total) items.push({ sha: `s${i}`, message: `m${i++}`, date: "2026-10-15T00:00:00Z", url: `https://github.com/${fullName}/commit/s${i}`, parents: 1 });
  return {
    repo: { fullName, url: `https://github.com/${fullName}`, description: null, stars: 1, defaultBranch: "main", language: null, archived: false, fork: false },
    commits: { items, capped: false },
    pulls: { items: [], capped: false },
    since: "2026-08-04T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    days: 90,
  };
}

const cases: [string, RepoData][] = [
  ["zero", data("acme/plain", [], 120)],
  ["tiny", data("acme/tiny", [["claude", 1]], 2000)],
  ["long-name", data("some-very-long-organisation/an-extremely-long-repository-name", [["copilot", 40]], 100)],
  ["multi-agent", data("acme/busy", [["claude", 120], ["copilot", 60], ["codex", 30], ["cursor", 10]], 500)],
];

/** Share of non-background pixels in a box, to prove that text was drawn. */
function ink(png: PNG, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (Math.abs(png.data[i]! - 0x10) + Math.abs(png.data[i + 1]! - 0x1b) + Math.abs(png.data[i + 2]! - 0x2c) > 60) n++;
    }
  return n / ((x1 - x0) * (y1 - y0));
}

describe("OG images (#13)", () => {
  mkdirSync(OUT, { recursive: true });
  for (const [name, d] of cases) {
    it(`${name} matches its baseline and has legible text`, () => {
      const buf = renderOgPng(buildReport(d));
      writeFileSync(join(OUT, `${name}.png`), buf);
      const png = PNG.sync.read(buf);
      expect([png.width, png.height]).toEqual([1200, 630]);
      expect(ink(png, 60, 150, 700, 210), "repo name").toBeGreaterThan(0.03);
      expect(ink(png, 56, 250, 600, 410), "big number").toBeGreaterThan(0.05);
      expect(ink(png, 60, 550, 700, 585), "coverage line").toBeGreaterThan(0.01);
      const file = join(BASE, `${name}.png`);
      if (UPDATE || !existsSync(file)) {
        mkdirSync(BASE, { recursive: true });
        writeFileSync(file, buf);
        return;
      }
      const base = PNG.sync.read(readFileSync(file));
      const diff = pixelmatch(base.data, png.data, null, 1200, 630, { threshold: 0.2 });
      expect(diff / (1200 * 630), `${name} differs from ${file}; run UPDATE_OG=1 npm test to accept`).toBeLessThan(0.003);
    });
  }

  it("fails loudly when a font file is missing", async () => {
    const { OG_FONTS } = await import("../scripts/lib/og");
    expect(OG_FONTS.every((f) => existsSync(f))).toBe(true);
  });
});
