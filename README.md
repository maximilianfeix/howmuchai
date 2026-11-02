<p align="center">
  <a href="https://maximilianfeix.github.io/howmuchai/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
      <img alt="howmuchai" src="brand/lockup-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">How much of this repo was built with AI?</h3>

<p align="center">
  Paste any public GitHub repo. howmuchai reads its recent commits and pull requests and counts the ones that carry an AI coding-agent signature: Claude Code, Copilot, Codex, Cursor, Devin, Jules, Aider and more. Every match links to its commit.
</p>

<p align="center">
  <a href="https://maximilianfeix.github.io/howmuchai/"><b>Try it</b></a> ·
  <a href="https://maximilianfeix.github.io/howmuchai/leaderboard/"><b>Leaderboard of the top 1,000 repos</b></a> ·
  <a href="https://maximilianfeix.github.io/howmuchai/method/">Method</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="https://maximilianfeix.github.io/howmuchai/r/microsoft/vscode/"><img alt="howmuchai card for microsoft/vscode" src="https://maximilianfeix.github.io/howmuchai/card/microsoft/vscode-dark.svg" width="495"></a>
</p>

## What it finds

<!-- findings:start -->
Snapshot of 976 of the 1,000 most-starred GitHub repos with a push in the last 30 days, 2026-11-02. [Live leaderboard](https://maximilianfeix.github.io/howmuchai/leaderboard/)

- **69%** of them (677) have at least one AI-signed commit in the last 90 days.
- **16%** of all 216,440 commits read carry an agent signature.
- By commits: Claude Code 28,557 (in 618 repos), GitHub Copilot 2,218 (in 185 repos), Cursor 1,817 (in 182 repos), Capy 867 (in 5 repos), OpenAI Codex 650 (in 66 repos).

| Repo | AI-signed commits | Mostly |
|---|---:|---|
| [colbymchenry/codegraph](https://maximilianfeix.github.io/howmuchai/r/colbymchenry/codegraph/) | 100% of 500 | Claude Code |
| [shanraisshan/claude-code-best-practice](https://maximilianfeix.github.io/howmuchai/r/shanraisshan/claude-code-best-practice/) | 100% of 492 | Claude Code |
| [garrytan/gbrain](https://maximilianfeix.github.io/howmuchai/r/garrytan/gbrain/) | 99% of 380 | Capy |
| [exo-explore/exo](https://maximilianfeix.github.io/howmuchai/r/exo-explore/exo/) | 99% of 124 | Claude Code |
| [modelcontextprotocol/servers](https://maximilianfeix.github.io/howmuchai/r/modelcontextprotocol/servers/) | 99% of 311 | Claude Code |
| [RSSNext/Folo](https://maximilianfeix.github.io/howmuchai/r/rssnext/folo/) | 98% of 489 | Claude Code |
| [pbakaus/impeccable](https://maximilianfeix.github.io/howmuchai/r/pbakaus/impeccable/) | 96% of 307 | Claude Code |
| [ColorlibHQ/AdminLTE](https://maximilianfeix.github.io/howmuchai/r/colorlibhq/adminlte/) | 96% of 50 | Claude Code |
| [nektos/act](https://maximilianfeix.github.io/howmuchai/r/nektos/act/) | 95% of 66 | Cursor |
| [vinta/awesome-python](https://maximilianfeix.github.io/howmuchai/r/vinta/awesome-python/) | 95% of 439 | Claude Code |
| [JuliusBrussee/caveman](https://maximilianfeix.github.io/howmuchai/r/juliusbrussee/caveman/) | 94% of 407 | Claude Code |
| [hugohe3/ppt-master](https://maximilianfeix.github.io/howmuchai/r/hugohe3/ppt-master/) | 93% of 491 | Claude Code |

Repos with at least 50 commits in the window. Lower bound: only disclosed signatures count.

Some well-known projects (newest up to 500 commits each, 2026-11-02): [microsoft/vscode](https://maximilianfeix.github.io/howmuchai/r/microsoft/vscode/) 89% (GitHub Copilot), [n8n-io/n8n](https://maximilianfeix.github.io/howmuchai/r/n8n-io/n8n/) 52%, [electron/electron](https://maximilianfeix.github.io/howmuchai/r/electron/electron/) 49%, [home-assistant/core](https://maximilianfeix.github.io/howmuchai/r/home-assistant/core/) 49%, [rails/rails](https://maximilianfeix.github.io/howmuchai/r/rails/rails/) 27%, [nodejs/node](https://maximilianfeix.github.io/howmuchai/r/nodejs/node/) 26% (mostly `Assisted-by: Codex`), [huggingface/transformers](https://maximilianfeix.github.io/howmuchai/r/huggingface/transformers/) 20%, [microsoft/TypeScript](https://maximilianfeix.github.io/howmuchai/r/microsoft/typescript/) 15%, [pytorch/pytorch](https://maximilianfeix.github.io/howmuchai/r/pytorch/pytorch/) 15%, [oven-sh/bun](https://maximilianfeix.github.io/howmuchai/r/oven-sh/bun/) 10%, [python/cpython](https://maximilianfeix.github.io/howmuchai/r/python/cpython/) 6%, [vercel/next.js](https://maximilianfeix.github.io/howmuchai/r/vercel/next.js/) 5%, [torvalds/linux](https://maximilianfeix.github.io/howmuchai/r/torvalds/linux/) 1.5% (`Assisted-by:` trailers), and 0% for kubernetes, rust, django and deno.
<!-- findings:end -->

## Use it

**In the browser:** [maximilianfeix.github.io/howmuchai](https://maximilianfeix.github.io/howmuchai/). Lookups run in your browser against the public GitHub API. No server, no tracking.

**In the terminal:**

```sh
npx github:maximilianfeix/howmuchai vercel/next.js
npx github:maximilianfeix/howmuchai oven-sh/bun --evidence   # list the matching commits
npx github:maximilianfeix/howmuchai owner/repo --json        # full report
```

Without a token GitHub allows 60 requests per hour, and a lookup needs about 10. Set `GITHUB_TOKEN` (any token, no scopes needed) for 5,000.

## Badge and card for your README

Tracked repos (the top 1,000 and every repo someone [asked for](https://github.com/maximilianfeix/howmuchai/issues/new?template=track-repo.yml)) get a badge and a card that update about once a day:

```markdown
[![AI-signed commits](https://maximilianfeix.github.io/howmuchai/badge/OWNER/REPO.svg)](https://maximilianfeix.github.io/howmuchai/r/OWNER/REPO/)
[![howmuchai](https://maximilianfeix.github.io/howmuchai/card/OWNER/REPO-dark.svg)](https://maximilianfeix.github.io/howmuchai/r/OWNER/REPO/)
```

Use lower-case `owner/repo` in the URL. `-light.svg` gives the light card.

There is also a badge with the experimental likely range from [Beyond signatures](#beyond-signatures-experimental). It reads `AI likely | 45–68%` where there is enough evidence, and otherwise `AI likely | ≥13%`, the disclosed share as a lower bound:

```markdown
[![AI likely](https://maximilianfeix.github.io/howmuchai/badge/likely/OWNER/REPO.svg)](https://maximilianfeix.github.io/howmuchai/r/OWNER/REPO/)
```

### GitHub Action

Measure your own repo on your own schedule and keep the files in the repo:

```yaml
# .github/workflows/howmuchai.yml
name: howmuchai
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
permissions:
  contents: write
jobs:
  measure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: maximilianfeix/howmuchai@v0
```

It writes `.github/howmuchai/card-dark.svg`, `card-light.svg`, `badge.svg`, `badge-likely.svg` and `report.json`, commits them, and adds a summary to the run. Inputs: `repository`, `days` (90), `output-dir`, `commit` (`true`), `token`. Outputs: `share`, `ai-commits`, `commits`, `likely`.

```markdown
![AI-signed commits](.github/howmuchai/badge.svg)
```

## MCP server

howmuchai is also an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, VS Code and other clients can ask it directly. It has four read-only tools:

| Tool | What it does |
|---|---|
| `measure_repo` | AI-signed share of a repo's commits and PRs, per agent, with evidence and the experimental range. Uses the stored daily measurement when there is one, else measures live |
| `leaderboard` | Rows of the top-1,000 leaderboard, filtered by name or agent and sorted by share, stars, signed commits or estimate |
| `check_commit` | Runs the signature registry on one commit message offline: which signatures match and whether they count |
| `list_signatures` | The signature registry, per agent |

Claude Code:

```bash
claude mcp add howmuchai -e GITHUB_TOKEN=$(gh auth token) -- npx -y github:maximilianfeix/howmuchai mcp
```

Claude Desktop, Cursor (`~/.cursor/mcp.json`) and other clients that use the `mcpServers` format:

```json
{
  "mcpServers": {
    "howmuchai": {
      "command": "npx",
      "args": ["-y", "github:maximilianfeix/howmuchai", "mcp"],
      "env": { "GITHUB_TOKEN": "<optional, any token without scopes>" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{ "servers": { "howmuchai": { "type": "stdio", "command": "npx", "args": ["-y", "github:maximilianfeix/howmuchai", "mcp"] } } }
```

The server speaks both protocol generations: the `initialize` handshake (2024-11-05 to 2025-11-25) and `server/discover` (2026-07-28). The token is optional and only needed for live measurements of untracked repos. It is sent only to api.github.com and never appears in tool output.

## How it measures

howmuchai does not guess and does not run an AI detector. It counts what is **disclosed**:

| Where | Examples |
|---|---|
| Commit trailers | `Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>`, `Co-authored-by: Copilot <…copilot@users.noreply.github.com>`, `Co-authored-by: gpt-6-astra (Codex) <…>`, `Co-authored-by: Cursor Agent <cursoragent@cursor.com>` |
| Commit and PR authors | `copilot-swe-agent[bot]`, `devin-ai-integration[bot]`, `google-labs-jules[bot]`, `claude[bot]`, `cursor[bot]`, `opencode-agent[bot]`, author names ending in `(aider)` |
| Footers | `🤖 Generated with [Claude Code](https://claude.com/claude-code)` |
| Hints, shown but not counted | PR branches `codex/`, `cursor/`, `claude/`, `copilot/`, `capy/`; the name `Junie` with a non-JetBrains address |

The full list with regular expressions lives in [`signatures/agents.json`](signatures/agents.json), built from what really shows up in the top 1,000 repos.

- **Window:** the last 90 days of the default branch, up to 500 commits, and up to 300 pull requests opened in that time. Busy repos reach the cap within days; the result then says "since &lt;date&gt;".
- **Left out:** merge commits and dependency bots (Dependabot, Renovate, GitHub Actions, pre-commit.ci and others).
- **One agent per item:** a commit with two signatures counts once, for the first matching agent.
- **Squash merges:** a commit without a signature of its own counts when GitHub records it as the merge commit (`merge_commit_sha`) of a merged pull request that carries one, for example the "Generated with Claude Code" footer. A "(#123)" in the subject alone is not enough, since reverts and backports carry other pull requests' numbers. Only pull requests opened in the window are looked at, so a squash of an older pull request can still be missed.

### Why the number is a lower bound

Signatures can be turned off, squash merges can drop them, and code pasted from a chat leaves no mark. A signature also says an agent was involved, not how many lines it wrote. So a high number means a lot of disclosed AI involvement, a low number does not mean little AI use, and **"no signature found" never means human-written**.

## Beyond signatures (experimental)

Many people remove agent signatures, so a repo built entirely with agents can show a low disclosed number. Every report therefore adds evidence that never changes the headline number, the badge or the leaderboard ranking:

- **Authors who disclose agent use:** the share of commits by people who sign at least one other commit in the window.
- **Agent setup files:** `CLAUDE.md`, `AGENTS.md`, `.cursor/`, `GEMINI.md`, `.github/copilot-instructions.md`, `copilot-setup-steps.yml` and others.
- **A style estimate with a 90% interval:** a small logistic model of commit-message style, trained on about 14,500 disclosed agent commits (signatures removed) against 13,000 commits from before coding agents in the same 152 repositories (exact numbers in [eval/STYLE.md](eval/STYLE.md)). It compares a repo's undisclosed commits with that repo's own commits from before July 2022 and with its disclosed agent commits.

```
maximilianfeix/proxy-scraper
AI-signed commits  13%
Beyond signatures (experimental)
  likely 47%–69% AI-involved, best estimate 55%
  98% of commits by 1/6 authors who disclose agent use here
```

On mixtures of 20 commits with a known AI share the median absolute error is about 3–10 percentage points (less for repos with more commits) and the 90% interval held the true share in all 125 test cases. Single commits cannot be judged reliably, and careful human writers score like agents, so an estimate is only made when the repo itself discloses at least 10 agent commits (they show what agent work looks like there) and, for repos older than July 2022, has enough commits from before that date (they show what human work looks like there). Agent setup files count as evidence of use, never as enough for an estimate. Details and all numbers: [`eval/STYLE.md`](eval/STYLE.md).

## FAQ

**Is this anti-AI?** No. It is a measuring tape. Many of the most-starred projects use agents openly, and the numbers show it. Whether that is good is up to you.

**My repo shows a number that looks wrong.** Open the evidence list on its page; every match links to the commit. If a match is wrong or an agent is missing, [open an issue](https://github.com/maximilianfeix/howmuchai/issues/new/choose).

**Can I measure a private repo?** Use the CLI or the Action with a token that can read it. The website only reads public repos.

**Where does the data come from?** The GitHub REST API. The crawler runs hourly in GitHub Actions and keeps its results in the [`data`](https://github.com/maximilianfeix/howmuchai/tree/data) branch, so the history of every number is in git.

## Develop

```sh
npm ci
npm run dev            # website on http://localhost:5173/howmuchai/
npm test               # classifier tests
npm run build          # site, CLI bundle and Action bundle
GITHUB_TOKEN=… npx tsx scripts/crawl.ts --data .data --max 20
```

New signatures go into `signatures/agents.json` with a test in `test/classify.test.ts` and a public example. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
