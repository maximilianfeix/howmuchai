import { analyzeRepo, DEFAULTS, parseRepo, VERSION } from "../core/analyze";
import { GitHubClient, GitHubError } from "../core/github";
import { agentColor, agentName } from "../core/registry";
import { coverageLabel } from "../core/render";
import type { Report, Section } from "../core/types";

const HELP = `howmuchai ${VERSION}
How much of a GitHub repo was built with AI? Counts commits and pull requests
that carry an AI coding-agent signature (a lower bound of disclosed AI use).

Usage
  npx howmuchai <owner/repo | github url> [options]

Options
  --days <n>       window in days (default ${DEFAULTS.days})
  --max <n>        max commits to read (default ${DEFAULTS.maxCommits})
  --json           print the full report as JSON
  --evidence       list the matching commits and pull requests
  -h, --help       show this help

A token raises the GitHub API limit from 60 to 5,000 requests per hour.
It is read from GITHUB_TOKEN or GH_TOKEN and only sent to api.github.com.
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s),
  hex: (hex: string, s: string) => {
    if (!useColor) return s;
    const n = parseInt(hex.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[39m`;
  },
};

/** Removes terminal control characters from text that comes from commits and pull requests. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

function pct(n: number, d: number): string {
  if (d === 0) return "–";
  const v = (100 * n) / d;
  return v > 0 && v < 0.1 ? "<0.1%" : `${v.toFixed(v < 10 ? 1 : 0)}%`;
}

function bar(sec: Section, width = 40): string {
  if (sec.total === 0) return c.dim("·".repeat(width));
  let out = "";
  let used = 0;
  const entries = Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of entries) {
    const w = Math.max(1, Math.round((n / sec.total) * width));
    if (used + w > width) break;
    out += c.hex(agentColor(id), "█".repeat(w));
    used += w;
  }
  return out + c.dim("░".repeat(width - used));
}

function section(title: string, sec: Section, unit: string, r: Report): string[] {
  const lines = [`${c.bold(title)}  ${c.bold(pct(sec.ai, sec.total))} ${c.dim(`(${sec.ai} of ${sec.total})`)}`];
  lines.push(`  ${bar(sec)}`);
  const entries = Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of entries) {
    lines.push(`  ${c.hex(agentColor(id), "■")} ${agentName(id).padEnd(16)} ${String(n).padStart(5)}  ${c.dim(pct(n, sec.total))}`);
  }
  if (sec.hints) {
    const by = Object.entries(sec.hintsByAgent).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${agentName(id)} ${n}`).join(", ");
    lines.push(c.dim(`  + ${sec.hints} with only a hint, not counted (${by})`));
  }
  lines.push(c.dim(`  ${coverageLabel(sec, r, unit)}`));
  return lines;
}

function render(r: Report, evidence: boolean): string {
  const lines = [
    "",
    `${c.bold(clean(r.repo.fullName))}  ${c.dim(`★ ${r.repo.stars.toLocaleString("en-US")} · measured ${r.window.until.slice(0, 10)}`)}`,
    "",
    ...section("AI-signed commits", r.commits, "commits", r),
    "",
    ...section("AI-signed pull requests", r.pulls, "pull requests", r),
    "",
  ];
  if (evidence) {
    lines.push(c.bold("Evidence"));
    for (const e of [...r.commits.evidence, ...r.pulls.evidence]) {
      lines.push(`  ${c.hex(agentColor(e.agentId), clean(e.ref).padEnd(8))} ${clean(e.title).slice(0, 70)}`);
      lines.push(`  ${c.dim(`         ${e.kind}: ${clean(e.matched)}  ${clean(e.url)}`)}`);
    }
    lines.push("");
  }
  lines.push(c.dim("Counts only work that discloses an AI agent (trailers, bot authors, PR footers)."));
  lines.push(c.dim("No signal does not mean human-written. Web: https://maximilianfeix.github.io/howmuchai/"));
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const days = Number(flag("--days") ?? DEFAULTS.days);
  const maxCommits = Number(flag("--max") ?? DEFAULTS.maxCommits);
  const json = args.includes("--json");
  const evidence = args.includes("--evidence");
  const target = args.find((a) => !a.startsWith("-"));
  const repo = target ? parseRepo(target) : null;
  if (!repo) {
    process.stderr.write(`Not a GitHub repository: ${target ?? "(none)"}\n`);
    process.exit(2);
  }
  if (!Number.isFinite(days) || days < 1 || days > 3650 || !Number.isFinite(maxCommits) || maxCommits < 1) {
    process.stderr.write("--days must be 1..3650 and --max a positive number\n");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const client = new GitHubClient({ token, userAgent: `howmuchai-cli/${VERSION}` });
  try {
    const report = await analyzeRepo(repo, { days, maxCommits, client });
    process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : render(report, evidence) + "\n");
  } catch (e) {
    if (e instanceof GitHubError && e.resetAt) {
      const mins = Math.max(1, Math.ceil((e.resetAt * 1000 - Date.now()) / 60000));
      process.stderr.write(`GitHub API rate limit reached. Try again in ${mins} min, or set GITHUB_TOKEN.\n`);
    } else if (e instanceof GitHubError && e.status === 404) {
      process.stderr.write(`Repository not found (or private): ${repo}\n`);
    } else {
      process.stderr.write(`${clean(e instanceof Error ? e.message : String(e))}\n`);
    }
    process.exit(1);
  }
}

main();
