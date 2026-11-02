/**
 * Handles a "track this repo" issue: validates the repository, adds it to tracked.json, measures it
 * right away, answers with the badge code and closes the issue.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildReport, fetchRepoData, parseRepo } from "../src/core/analyze";
import { badgePath, cardPath, pagePath, reportPath } from "../src/core/dataset";
import { formatShare } from "../src/core/format";
import { GitHubClient, GitHubError } from "../src/core/github";
import { renderBadge, renderCard, shieldsJson } from "../src/core/render";
import { validateReport } from "../src/core/validate";
import { writeAtomic } from "./lib/fsutil";

const DATA = process.argv.includes("--data") ? process.argv[process.argv.indexOf("--data") + 1]! : ".data";
const SITE = (process.env.HOWMUCHAI_SITE ?? "https://maximilianfeix.github.io/howmuchai").replace(/\/$/, "");
const MAX_TRACKED = 3000;
const token = process.env.GITHUB_TOKEN!;
const body = process.env.ISSUE_BODY ?? "";
const client = new GitHubClient({ token, userAgent: "howmuchai-track" });

/**
 * The answer is not posted here: it is written to ANSWER_FILE and the workflow posts it only after the
 * data has been pushed, so a requester is never told "tracked" when nothing was saved.
 */
function answer(text: string, reason: "completed" | "not planned", changed = false) {
  writeAtomic(process.env.ANSWER_FILE ?? "answer.json", JSON.stringify({ body: text, reason, changed }));
}

function countTracked(): number {
  const dir = join(DATA, "tracked");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, owner) => n + readdirSync(join(dir, owner)).length, 0);
}

function write(rel: string, content: string) {
  writeAtomic(join(DATA, rel), content);
}

async function main() {
  // Issue forms render the field as "### Repository\n\n<value>"
  const field = /###\s*Repository\s*\n+\s*([^\n]+)/i.exec(body)?.[1] ?? body;
  const repo = parseRepo(field.trim());
  if (!repo) {
    answer("I could not read a repository from this issue. Please use the form and enter `owner/repo`.", "not planned");
    return;
  }
  // One file per tracked repo (tracked/<owner>/<repo>.json), so parallel requests never touch the same file.
  if (countTracked() >= MAX_TRACKED) {
    answer("The tracking list is full for now. You can still run the GitHub Action in your own repo: https://github.com/maximilianfeix/howmuchai#github-action", "not planned");
    return;
  }
  let raw;
  try {
    raw = await fetchRepoData(repo, { client });
  } catch (e) {
    const msg = e instanceof GitHubError && e.status === 404 ? `\`${repo}\` was not found or is private. howmuchai only reads public repositories.` : `Could not read \`${repo}\` right now. Please try again later.`;
    answer(msg, "not planned");
    return;
  }
  const r = buildReport(raw);
  const v = validateReport(r);
  if (!v.ok) throw new Error(`invalid report: ${v.errors.join("; ")}`);
  const name = r.repo.fullName;
  write(`tracked/${name.toLowerCase()}.json`, JSON.stringify({ repo: name, requestedAt: new Date().toISOString() }) + "\n");
  write(reportPath(name), JSON.stringify(r) + "\n");
  write(badgePath(name), renderBadge(r));
  write(badgePath(name).replace(/\.svg$/, ".json"), JSON.stringify(shieldsJson(r)));
  write(cardPath(name, "dark"), renderCard(r, "dark"));
  write(cardPath(name, "light"), renderCard(r, "light"));

  const page = `${SITE}/${pagePath(name)}`;
  const share = formatShare(r.commits.ai, r.commits.total);
  answer(
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
    true,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
