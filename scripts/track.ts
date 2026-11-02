/**
 * Handles a "track this repo" issue: validates the repository, adds it to tracked.json, measures it
 * right away, answers with the badge code and closes the issue.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildReport, fetchRepoData, parseRepo } from "../src/core/analyze";
import { badgePath, cardPath, pagePath, reportPath } from "../src/core/dataset";
import { formatShare } from "../src/core/format";
import { GitHubClient, GitHubError } from "../src/core/github";
import { renderBadge, renderCard, shieldsJson } from "../src/core/render";

const DATA = process.argv.includes("--data") ? process.argv[process.argv.indexOf("--data") + 1]! : ".data";
const SITE = (process.env.HOWMUCHAI_SITE ?? "https://maximilianfeix.github.io/howmuchai").replace(/\/$/, "");
const MAX_TRACKED = 3000;
const token = process.env.GITHUB_TOKEN!;
const issue = Number(process.env.ISSUE_NUMBER);
const self = process.env.REPOSITORY!;
const body = process.env.ISSUE_BODY ?? "";
const client = new GitHubClient({ token, userAgent: "howmuchai-track" });

async function api(method: string, path: string, payload?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "howmuchai-track" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
}

async function answer(text: string, reason: "completed" | "not_planned") {
  await api("POST", `/repos/${self}/issues/${issue}/comments`, { body: text });
  await api("PATCH", `/repos/${self}/issues/${issue}`, { state: "closed", state_reason: reason });
}

function write(rel: string, content: string) {
  const p = join(DATA, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

async function main() {
  // Issue forms render the field as "### Repository\n\n<value>"
  const field = /###\s*Repository\s*\n+\s*([^\n]+)/i.exec(body)?.[1] ?? body;
  const repo = parseRepo(field.trim());
  if (!repo) {
    await answer("I could not read a repository from this issue. Please use the form and enter `owner/repo`.", "not_planned");
    return;
  }
  const trackedFile = join(DATA, "tracked.json");
  const tracked = existsSync(trackedFile) ? (JSON.parse(readFileSync(trackedFile, "utf8")) as { repos: string[] }) : { repos: [] };
  if (tracked.repos.length >= MAX_TRACKED) {
    await answer("The tracking list is full for now. You can still run the GitHub Action in your own repo: https://github.com/maximilianfeix/howmuchai#github-action", "not_planned");
    return;
  }
  let raw;
  try {
    raw = await fetchRepoData(repo, { client });
  } catch (e) {
    const msg = e instanceof GitHubError && e.status === 404 ? `\`${repo}\` was not found or is private. howmuchai only reads public repositories.` : `Could not read \`${repo}\` right now. Please try again later.`;
    await answer(msg, "not_planned");
    return;
  }
  const r = buildReport(raw);
  const name = r.repo.fullName;
  if (!tracked.repos.some((x) => x.toLowerCase() === name.toLowerCase())) tracked.repos.push(name);
  write("tracked.json", JSON.stringify(tracked, null, 1) + "\n");
  write(reportPath(name), JSON.stringify(r) + "\n");
  write(badgePath(name), renderBadge(r));
  write(badgePath(name).replace(/\.svg$/, ".json"), JSON.stringify(shieldsJson(r)));
  write(cardPath(name, "dark"), renderCard(r, "dark"));
  write(cardPath(name, "light"), renderCard(r, "light"));

  const page = `${SITE}/${pagePath(name)}`;
  const share = formatShare(r.commits.ai, r.commits.total);
  await answer(
    [
      `**${name}** is tracked now and will be measured about once a day. Right now: **${share}** of ${r.commits.total} recent commits carry an AI agent signature.`,
      ``,
      `Page: ${page} (live in a few minutes)`,
      ``,
      `Badge:`,
      "```markdown",
      `[![AI-signed commits](${SITE}/${badgePath(name)})](${page})`,
      "```",
      `Card:`,
      "```markdown",
      `[![howmuchai card for ${name}](${SITE}/${cardPath(name, "dark")})](${page})`,
      "```",
    ].join("\n"),
    "completed",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
