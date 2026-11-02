/**
 * Fails (exit 1) when the published leaderboard is missing, invalid or stale:
 *   - generatedAt older than --max-age-hours (48)
 *   - more than --max-stale-share (0.1) of the top cohort measured more than 48 hours ago
 *   - the top cohort is less than --min-measured-share (0.9) of the selected repos
 *   tsx scripts/freshness.ts <leaderboard.json | URL> [options]
 */
import { readFileSync } from "node:fs";
import { topCohort } from "../src/core/dataset";
import { validateBoard } from "../src/core/validate";

export interface FreshnessResult {
  ok: boolean;
  problems: string[];
  summary: string;
}

export function checkFreshness(json: unknown, now: Date, opts = { maxAgeHours: 48, maxStaleShare: 0.1, minMeasuredShare: 0.9 }): FreshnessResult {
  const v = validateBoard(json);
  if (!v.ok) return { ok: false, problems: [`invalid leaderboard: ${v.errors.join("; ")}`], summary: "invalid" };
  const b = v.value;
  const problems: string[] = [];
  const ageH = (now.getTime() - Date.parse(b.generatedAt)) / 3_600_000;
  if (ageH > opts.maxAgeHours) problems.push(`leaderboard is ${ageH.toFixed(0)} h old (limit ${opts.maxAgeHours} h)`);
  const cohort = topCohort(b);
  const staleBefore = now.getTime() - 48 * 3_600_000;
  const stale = cohort.filter((e) => Date.parse(e.measuredAt) < staleBefore).length;
  if (cohort.length === 0) problems.push("top cohort is empty");
  else if (stale / cohort.length > opts.maxStaleShare) problems.push(`${stale} of ${cohort.length} measurements are older than 48 h`);
  const selected = b.cohort?.selected ?? cohort.length;
  if (selected > 0 && cohort.length / selected < opts.minMeasuredShare) problems.push(`only ${cohort.length} of ${selected} selected repos are measured`);
  const oldest = cohort.reduce<string | null>((m, e) => (!m || e.measuredAt < m ? e.measuredAt : m), null);
  return {
    ok: problems.length === 0,
    problems,
    summary: `board ${ageH.toFixed(1)} h old, ${cohort.length}/${selected} measured, ${stale} older than 48 h, oldest ${oldest ?? "-"}`,
  };
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error("usage: freshness.ts <leaderboard.json | URL>");
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : readFileSync(src, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("::error::leaderboard is not JSON");
    process.exit(1);
  }
  const r = checkFreshness(json, new Date());
  console.log(r.summary);
  for (const p of r.problems) console.error(`::error::${p}`);
  if (!r.ok) process.exit(1);
}

if (process.argv[1]?.endsWith("freshness.ts")) main();
