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

It writes `.github/howmuchai/card-dark.svg`, `card-light.svg`, `badge.svg` and `report.json`, commits them, and adds a summary to the run. Inputs: `repository`, `days` (90), `output-dir`, `commit` (`true`), `token`. Outputs: `share`, `ai-commits`, `commits`.

```markdown
![AI-signed commits](.github/howmuchai/badge.svg)
```

## How it measures

howmuchai does not guess and does not run an AI detector. It counts what is **disclosed**:

| Where | Examples |
|---|---|
| Commit trailers | `Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>`, `Co-authored-by: Copilot <…copilot@users.noreply.github.com>`, `Co-authored-by: gpt-6-astra (Codex) <…>`, `Co-authored-by: Cursor Agent <cursoragent@cursor.com>` |
| Commit and PR authors | `copilot-swe-agent[bot]`, `devin-ai-integration[bot]`, `google-labs-jules[bot]`, `claude[bot]`, `cursor[bot]`, `opencode-agent[bot]`, author names ending in `(aider)` |
| Footers | `🤖 Generated with [Claude Code](https://claude.com/claude-code)` |
| Hints, shown but not counted | PR branches `codex/`, `cursor/`, `claude/`, `copilot/`, `capy/`; the bare name `Junie` |

The full list with regular expressions lives in [`signatures/agents.json`](signatures/agents.json), built from what really shows up in the top 1,000 repos.

- **Window:** the last 90 days of the default branch, up to 500 commits, and up to 300 pull requests opened in that time. Busy repos reach the cap within days; the result then says "since &lt;date&gt;".
- **Left out:** merge commits and dependency bots (Dependabot, Renovate, GitHub Actions, pre-commit.ci and others).
- **One agent per item:** a commit with two signatures counts once, for the first matching agent.

### Why the number is a lower bound

Signatures can be turned off, squash merges can drop them, and code pasted from a chat leaves no mark. A signature also says an agent was involved, not how many lines it wrote. So a high number means a lot of disclosed AI involvement, a low number does not mean little AI use, and **"no signature found" never means human-written**.

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
