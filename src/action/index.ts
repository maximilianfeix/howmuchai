/**
 * GitHub Action: measures a repository and writes a README card, a badge and the report into the repo.
 * Inputs arrive as INPUT_<NAME> environment variables (see action.yml).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRepo, DEFAULTS } from "../core/analyze";
import { formatShare } from "../core/format";
import { GitHubClient } from "../core/github";
import { agentName } from "../core/registry";
import { periodLabel, renderBadge, renderCard } from "../core/render";

function input(name: string, def = ""): string {
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? def).trim() || def;
}

function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function git(args: string[]) {
  execFileSync("git", args, { stdio: "inherit" });
}

async function run() {
  const repo = input("repository", process.env.GITHUB_REPOSITORY ?? "");
  const days = Number(input("days", String(DEFAULTS.days)));
  const dir = input("output-dir", ".github/howmuchai");
  const commit = input("commit", "true") === "true";
  const token = input("token", process.env.GITHUB_TOKEN ?? "");
  if (!repo) throw new Error("No repository given");

  const client = new GitHubClient({ token, userAgent: "howmuchai-action" });
  const r = await analyzeRepo(repo, { client, days });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "card-dark.svg"), renderCard(r, "dark"));
  writeFileSync(join(dir, "card-light.svg"), renderCard(r, "light"));
  writeFileSync(join(dir, "badge.svg"), renderBadge(r));
  writeFileSync(join(dir, "report.json"), JSON.stringify(r, null, 2) + "\n");

  const share = formatShare(r.commits.ai, r.commits.total);
  setOutput("share", share);
  setOutput("ai-commits", String(r.commits.ai));
  setOutput("commits", String(r.commits.total));
  console.log(`${r.repo.fullName}: ${share} AI-signed commits (${r.commits.ai} of ${r.commits.total}, ${periodLabel(r)})`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(r.commits.byAgent)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `| ${agentName(id)} | ${n} | ${formatShare(n, r.commits.total)} |`)
      .join("\n");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## howmuchai: ${share} AI-signed commits\n\n${periodLabel(r)} on \`${r.repo.defaultBranch}\`. Pull requests: ${formatShare(r.pulls.ai, r.pulls.total)} (${r.pulls.ai} of ${r.pulls.total}).\n\n| Agent | Commits | Share |\n|---|---:|---:|\n${rows || "| No signatures found | 0 | 0% |"}\n\nCounts disclosed signatures only, a lower bound. [Method](https://maximilianfeix.github.io/howmuchai/method/)\n`,
    );
  }

  if (commit) {
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    git(["add", dir]);
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"]);
      console.log("No changes to commit");
    } catch {
      git(["commit", "-m", `chore(howmuchai): ${share} AI-signed commits`]);
      git(["push"]);
    }
  }
}

run().catch((e) => {
  console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
