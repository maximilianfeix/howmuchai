/** Writes the "What it finds" block of README.md from data/leaderboard.json. */
import { readFileSync, writeFileSync } from "node:fs";
import { topCohort, type Board } from "../src/core/dataset";
import { formatShare } from "../src/core/format";
import { agentName } from "../src/core/registry";

const SITE = "https://maximilianfeix.github.io/howmuchai";
const data = process.argv[2] ?? ".data/data/leaderboard.json";
const b = JSON.parse(readFileSync(data, "utf8")) as Board;
const cohort = topCohort(b);
const measured = cohort.filter((e) => e.total > 0);
const withAi = measured.filter((e) => e.ai > 0);
const totalCommits = measured.reduce((s, e) => s + e.total, 0);
const aiCommits = measured.reduce((s, e) => s + e.ai, 0);
const byAgent: Record<string, number> = {};
const reposByAgent: Record<string, number> = {};
for (const e of measured)
  for (const [id, n] of Object.entries(e.byAgent)) {
    byAgent[id] = (byAgent[id] ?? 0) + n;
    reposByAgent[id] = (reposByAgent[id] ?? 0) + 1;
  }
const top = measured
  .filter((e) => e.total >= 50)
  .sort((a, z) => (z.share ?? 0) - (a.share ?? 0))
  .slice(0, 12);
const link = (n: string) => `[${n}](${SITE}/r/${n.toLowerCase()}/)`;
const lines = [
  `Snapshot of ${measured.length.toLocaleString("en-US")} of the ${(b.cohort?.selected ?? cohort.length).toLocaleString("en-US")} most-starred GitHub repos with a push in the last 30 days, ${b.generatedAt.slice(0, 10)}. [Live leaderboard](${SITE}/leaderboard/)`,
  ``,
  `- **${formatShare(withAi.length, measured.length)}** of them (${withAi.length}) have at least one AI-signed commit in the last ${b.days} days.`,
  `- **${formatShare(aiCommits, totalCommits)}** of all ${totalCommits.toLocaleString("en-US")} commits read carry an agent signature.`,
  `- By commits: ${Object.entries(byAgent)
    .sort((a, z) => z[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => `${agentName(id)} ${n.toLocaleString("en-US")} (in ${reposByAgent[id]} repos)`)
    .join(", ")}.`,
  ``,
  `| Repo | AI-signed commits | Mostly |`,
  `|---|---:|---|`,
  ...top.map((e) => `| ${link(e.fullName)} | ${formatShare(e.ai, e.total)} of ${e.total} | ${e.top ? agentName(e.top) : "–"} |`),
  ``,
  `Repos with at least 50 commits in the window. Lower bound: only disclosed signatures count.`,
];
const readme = readFileSync("README.md", "utf8");
const out = readme.replace(/<!-- findings:start -->[\s\S]*<!-- findings:end -->/, `<!-- findings:start -->\n${lines.join("\n")}\n<!-- findings:end -->`);
writeFileSync("README.md", out);
console.log(lines.join("\n"));
