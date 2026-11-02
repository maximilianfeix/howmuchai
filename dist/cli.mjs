#!/usr/bin/env node

// src/core/classify.ts
function createClassifier(reg) {
  const signals = [];
  for (const agent of reg.agents) {
    for (const s of agent.signals) {
      signals.push({ agentId: agent.id, kind: s.kind, re: new RegExp(s.pattern, "im"), confidence: s.confidence });
    }
  }
  const ignored = new Set(reg.ignoredAuthors.map((a) => a.toLowerCase()));
  const of = (kind) => signals.filter((s) => s.kind === kind);
  const trailer = of("commit-trailer");
  const message = of("commit-message");
  const author = of("commit-author");
  const prAuthor = of("pr-author");
  const prBody = of("pr-body");
  const prBranch = of("pr-branch");
  function run(list, text, out) {
    if (!text) return;
    if (text.length > 65536) text = text.slice(0, 65536);
    for (const s of list) {
      const m = s.re.exec(text);
      if (m) out.push({ agentId: s.agentId, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
    }
  }
  function dedupe(matches) {
    const seen = /* @__PURE__ */ new Set();
    return matches.filter((m) => {
      const k = m.agentId;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return {
    commit(c2) {
      const out = [];
      run(trailer, c2.message, out);
      run(message, c2.message, out);
      for (const field of [c2.authorLogin, c2.authorName, c2.authorEmail, c2.committerLogin, c2.committerName, c2.committerEmail]) {
        run(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out = [];
      run(prAuthor, p.authorLogin, out);
      run(prBody, p.body, out);
      run(prBranch, p.branch, out);
      return dedupe(out);
    },
    isIgnoredCommit(c2) {
      if (c2.parents > 1) return true;
      const login = (c2.authorLogin ?? "").toLowerCase();
      const name = (c2.authorName ?? "").toLowerCase();
      return ignored.has(login) || ignored.has(name);
    },
    isIgnoredPull(p) {
      return ignored.has((p.authorLogin ?? "").toLowerCase());
    }
  };
}

// src/core/github.ts
var GitHubError = class extends Error {
  constructor(message, status, resetAt = null) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
    this.name = "GitHubError";
  }
  status;
  resetAt;
};
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
var GitHubClient = class {
  constructor(opts = {}) {
    this.opts = opts;
    this.base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.doFetch = opts.fetch ?? fetch.bind(globalThis);
  }
  opts;
  base;
  doFetch;
  lastRate = null;
  requests = 0;
  async get(path) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (!isBrowser) headers["User-Agent"] = this.opts.userAgent ?? "howmuchai";
    const res = await this.doFetch(`${this.base}${path}`, { headers });
    this.requests++;
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resource = res.headers.get("x-ratelimit-resource") ?? "core";
    if (resource === "core" && res.headers.has("x-ratelimit-limit")) this.lastRate = { limit, remaining, reset };
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
      } catch {
      }
      const rateLimited = (res.status === 403 || res.status === 429) && (remaining === 0 || /rate limit/i.test(msg));
      throw new GitHubError(msg, res.status, rateLimited ? reset || null : null);
    }
    return await res.json();
  }
  async repo(fullName) {
    const r = await this.get(`/repos/${fullName}`);
    return {
      fullName: r.full_name,
      url: r.html_url,
      description: r.description,
      stars: r.stargazers_count,
      defaultBranch: r.default_branch,
      language: r.language,
      archived: r.archived,
      fork: r.fork
    };
  }
  /** Commits on the default branch since `since`, newest first, at most `max`. */
  async commits(fullName, since, max) {
    const items = [];
    const perPage = 100;
    for (let page = 1; items.length < max; page++) {
      const batch = await this.get(
        `/repos/${fullName}/commits?since=${encodeURIComponent(since)}&per_page=${perPage}&page=${page}`
      );
      for (const c2 of batch) items.push(toCommit(c2));
      if (batch.length < perPage) return { items: items.slice(0, max), capped: false };
    }
    return { items: items.slice(0, max), capped: true };
  }
  /** Pull requests opened since `since`, newest first, at most `max`. */
  async pulls(fullName, since, max) {
    const items = [];
    const perPage = 100;
    const sinceMs = Date.parse(since);
    for (let page = 1; items.length < max; page++) {
      let batch;
      try {
        batch = await this.get(
          `/repos/${fullName}/pulls?state=all&sort=created&direction=desc&per_page=${perPage}&page=${page}`
        );
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404 && page === 1) return { items: [], capped: false };
        throw e;
      }
      for (const p of batch) {
        if (Date.parse(p.created_at) < sinceMs) return { items: items.slice(0, max), capped: false };
        items.push(toPull(p));
      }
      if (batch.length < perPage) return { items: items.slice(0, max), capped: false };
    }
    return { items: items.slice(0, max), capped: true };
  }
};
function toCommit(c2) {
  return {
    sha: c2.sha,
    message: c2.commit.message ?? "",
    date: c2.commit.committer?.date ?? c2.commit.author?.date ?? "",
    url: c2.html_url,
    authorName: c2.commit.author?.name ?? null,
    authorEmail: c2.commit.author?.email ?? null,
    authorLogin: c2.author?.login ?? null,
    committerName: c2.commit.committer?.name ?? null,
    committerEmail: c2.commit.committer?.email ?? null,
    committerLogin: c2.committer?.login ?? null,
    parents: c2.parents?.length ?? 1
  };
}
function toPull(p) {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    authorLogin: p.user?.login ?? null,
    branch: p.head?.ref ?? "",
    createdAt: p.created_at,
    mergedAt: p.merged_at,
    url: p.html_url
  };
}

// signatures/agents.json
var agents_default = {
  version: 2,
  ignoredAuthors: [
    "dependabot[bot]",
    "dependabot-preview[bot]",
    "renovate[bot]",
    "renovate-bot",
    "github-actions[bot]",
    "pre-commit-ci[bot]",
    "allcontributors[bot]",
    "imgbot[bot]",
    "snyk-bot",
    "greenkeeper[bot]",
    "mergify[bot]",
    "release-please[bot]",
    "changeset-bot[bot]"
  ],
  agents: [
    {
      id: "claude-code",
      name: "Claude Code",
      color: "#8D9DFF",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*claude\\b[^<\\n]*<noreply@anthropic\\.com>",
          confidence: "high",
          note: 'Added by Claude Code; the name carries the model, e.g. "Claude Opus 5.5 (1M context)"'
        },
        {
          kind: "commit-message",
          pattern: "generated (with|by) \\[?claude code\\]?",
          confidence: "high",
          note: 'Default footer "\u{1F916} Generated with Claude Code"'
        },
        {
          kind: "commit-author",
          pattern: "^claude\\[bot\\]$|^noreply@anthropic\\.com$",
          confidence: "high",
          note: "Claude GitHub app and Claude Code on the web (account @claude, owned by Anthropic)"
        },
        {
          kind: "pr-author",
          pattern: "^claude(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-body",
          pattern: "generated (with|by) \\[?claude code\\]?",
          confidence: "high"
        },
        {
          kind: "pr-branch",
          pattern: "^claude/",
          confidence: "medium",
          note: "Default branch prefix of Claude Code on the web and the Claude GitHub app"
        }
      ]
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      color: "#4DB8A4",
      signals: [
        {
          kind: "commit-author",
          pattern: "^copilot(-swe-agent)?(\\[bot\\])?$",
          confidence: "high",
          note: "Copilot coding agent"
        },
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*copilot\\b[^\\n]*<[^>]*copilot@users\\.noreply\\.github\\.com>",
          confidence: "high",
          note: "Added by Copilot in VS Code and on github.com when AI-generated changes are committed"
        },
        {
          kind: "pr-author",
          pattern: "^(app/)?copilot(-swe-agent)?(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-branch",
          pattern: "^copilot/",
          confidence: "medium",
          note: "Default branch prefix of the Copilot coding agent"
        }
      ]
    },
    {
      id: "codex",
      name: "OpenAI Codex",
      color: "#E6B75A",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*\\bcodex\\b[^<\\n]*<[^>\\n]*>",
          confidence: "high",
          note: 'Codex CLI, e.g. "gpt-6-astra (Codex) <agent@example.invalid>"'
        },
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<noreply@openai\\.com>",
          confidence: "high"
        },
        {
          kind: "pr-author",
          pattern: "^chatgpt-codex-connector(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-branch",
          pattern: "^codex/",
          confidence: "medium",
          note: "Default branch prefix of Codex cloud tasks"
        }
      ]
    },
    {
      id: "cursor",
      name: "Cursor",
      color: "#D891C8",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<cursoragent@cursor\\.com>",
          confidence: "high",
          note: '"Cursor Agent" or "Cursor"'
        },
        {
          kind: "commit-author",
          pattern: "^(cursoragent|cursor\\[bot\\])$|^cursoragent@cursor\\.com$",
          confidence: "high"
        },
        {
          kind: "pr-author",
          pattern: "^cursor(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-branch",
          pattern: "^cursor/",
          confidence: "medium",
          note: "Default branch prefix of Cursor background agents"
        }
      ]
    },
    {
      id: "devin",
      name: "Devin",
      color: "#62B9DB",
      signals: [
        {
          kind: "commit-author",
          pattern: "^devin-ai-integration(\\[bot\\])?$|devin-ai-integration\\[bot\\]@users\\.noreply\\.github\\.com",
          confidence: "high"
        },
        {
          kind: "pr-author",
          pattern: "^devin-ai-integration(\\[bot\\])?$",
          confidence: "high"
        }
      ]
    },
    {
      id: "jules",
      name: "Google Jules",
      color: "#B0BF65",
      signals: [
        {
          kind: "commit-author",
          pattern: "^google-labs-jules(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-author",
          pattern: "^google-labs-jules(\\[bot\\])?$",
          confidence: "high"
        }
      ]
    },
    {
      id: "aider",
      name: "Aider",
      color: "#ED9983",
      signals: [
        {
          kind: "commit-author",
          pattern: "\\(aider\\)$",
          confidence: "high",
          note: "Aider appends (aider) to the author name"
        },
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*aider\\b",
          confidence: "high"
        }
      ]
    },
    {
      id: "amp",
      name: "Amp",
      color: "#B39BDC",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*amp\\s*<amp@ampcode\\.com>",
          confidence: "high"
        },
        {
          kind: "commit-trailer",
          pattern: "^amp-thread(-id)?:\\s*https://ampcode\\.com/",
          confidence: "high"
        }
      ]
    },
    {
      id: "openhands",
      name: "OpenHands",
      color: "#88AFBE",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*openhands\\s*<openhands@all-hands\\.dev>",
          confidence: "high"
        },
        {
          kind: "commit-author",
          pattern: "^openhands(-agent)?(\\[bot\\])?$|openhands@all-hands\\.dev",
          confidence: "high"
        }
      ]
    },
    {
      id: "capy",
      name: "Capy",
      color: "#C9A27E",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<[^>]*capy-ai\\[bot\\]@users\\.noreply\\.github\\.com>",
          confidence: "high",
          note: "Capy AI GitHub app (capy.ai)"
        },
        {
          kind: "commit-author",
          pattern: "^capy-ai(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-author",
          pattern: "^capy-ai(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "pr-branch",
          pattern: "^capy/",
          confidence: "medium"
        }
      ]
    },
    {
      id: "opencode",
      name: "opencode",
      color: "#7FC7A6",
      signals: [
        {
          kind: "commit-author",
          pattern: "^opencode-agent(\\[bot\\])?$",
          confidence: "high",
          note: "OpenCode Agent GitHub app (opencode.ai)"
        },
        {
          kind: "pr-author",
          pattern: "^opencode-agent(\\[bot\\])?$",
          confidence: "high"
        },
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*opencode\\b[^\\n]*<",
          confidence: "high"
        }
      ]
    },
    {
      id: "junie",
      name: "JetBrains Junie",
      color: "#E58FB0",
      signals: [
        {
          kind: "commit-trailer",
          pattern: "^co-authored-by:\\s*junie\\b[^\\n]*<",
          confidence: "medium",
          note: "JetBrains Junie"
        }
      ]
    }
  ]
};

// src/core/registry.ts
var registry = agents_default;
var byId = new Map(registry.agents.map((a) => [a.id, a]));
function agentName(id) {
  return byId.get(id)?.name ?? id;
}
function agentColor(id) {
  return byId.get(id)?.color ?? "#8b949e";
}

// src/core/analyze.ts
var VERSION = "0.1.0";
var DEFAULTS = { days: 90, maxCommits: 500, maxPulls: 300, evidenceLimit: 40 };
function parseRepo(input) {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(s);
  if (!m) return null;
  if (m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}
function emptySection() {
  return { total: 0, ai: 0, byAgent: {}, byMonth: [], evidence: [], capped: false, oldest: null };
}
function bucket(months, date) {
  const month = date.slice(0, 7);
  let b = months.get(month);
  if (!b) {
    b = { month, total: 0, ai: 0, byAgent: {} };
    months.set(month, b);
  }
  return b;
}
function firstLine(s) {
  return (s.split("\n")[0] ?? "").trim().slice(0, 140);
}
function summarizeCommits(items, cls, evidenceLimit) {
  const sec = emptySection();
  const months = /* @__PURE__ */ new Map();
  for (const c2 of items) {
    if (cls.isIgnoredCommit(c2)) continue;
    sec.total++;
    if (!sec.oldest || c2.date < sec.oldest) sec.oldest = c2.date;
    const b = bucket(months, c2.date);
    b.total++;
    const matches = cls.commit(c2);
    if (matches.length === 0) continue;
    sec.ai++;
    b.ai++;
    const primary = matches[0].agentId;
    sec.byAgent[primary] = (sec.byAgent[primary] ?? 0) + 1;
    b.byAgent[primary] = (b.byAgent[primary] ?? 0) + 1;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0], c2.sha.slice(0, 7), firstLine(c2.message), c2.date, c2.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}
function summarizePulls(items, cls, evidenceLimit) {
  const sec = emptySection();
  const months = /* @__PURE__ */ new Map();
  for (const p of items) {
    if (cls.isIgnoredPull(p)) continue;
    sec.total++;
    if (!sec.oldest || p.createdAt < sec.oldest) sec.oldest = p.createdAt;
    const b = bucket(months, p.createdAt);
    b.total++;
    const matches = cls.pull(p);
    if (matches.length === 0) continue;
    sec.ai++;
    b.ai++;
    const primary = matches[0].agentId;
    sec.byAgent[primary] = (sec.byAgent[primary] ?? 0) + 1;
    b.byAgent[primary] = (b.byAgent[primary] ?? 0) + 1;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0], `#${p.number}`, p.title.slice(0, 140), p.createdAt, p.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}
function toEvidence(m, ref, title, date, url) {
  return { agentId: m.agentId, kind: m.kind, ref, title, date, url, matched: m.matched, confidence: m.confidence };
}
async function fetchRepoData(input, opts = {}) {
  const fullName = parseRepo(input);
  if (!fullName) throw new Error(`Not a GitHub repository: ${input}`);
  const days = opts.days ?? DEFAULTS.days;
  const client = opts.client ?? new GitHubClient();
  const now = opts.now ?? /* @__PURE__ */ new Date();
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const repo = await client.repo(fullName);
  const [commits, pulls] = await Promise.all([
    client.commits(repo.fullName, since, opts.maxCommits ?? DEFAULTS.maxCommits),
    client.pulls(repo.fullName, since, opts.maxPulls ?? DEFAULTS.maxPulls)
  ]);
  return { repo, commits, pulls, since, until: now.toISOString(), days };
}
function buildReport(d, opts = {}) {
  const evidenceLimit = opts.evidenceLimit ?? DEFAULTS.evidenceLimit;
  const cls = createClassifier(registry);
  const cSec = summarizeCommits(d.commits.items, cls, evidenceLimit);
  cSec.capped = d.commits.capped;
  const pSec = summarizePulls(d.pulls.items, cls, evidenceLimit);
  pSec.capped = d.pulls.capped;
  return {
    schema: 1,
    tool: { name: "howmuchai", version: VERSION, registry: registry.version },
    repo: {
      fullName: d.repo.fullName,
      url: d.repo.url,
      description: d.repo.description,
      stars: d.repo.stars,
      defaultBranch: d.repo.defaultBranch,
      language: d.repo.language
    },
    window: { since: d.since, until: d.until, days: d.days },
    commits: cSec,
    pulls: pSec,
    share: cSec.total > 0 ? cSec.ai / cSec.total : null,
    generatedAt: d.until
  };
}
async function analyzeRepo(input, opts = {}) {
  return buildReport(await fetchRepoData(input, opts), opts);
}

// src/cli/index.ts
var HELP = `howmuchai ${VERSION}
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
var useColor = process.stdout.isTTY && !process.env.NO_COLOR;
var c = {
  bold: (s) => useColor ? `\x1B[1m${s}\x1B[22m` : s,
  dim: (s) => useColor ? `\x1B[2m${s}\x1B[22m` : s,
  hex: (hex, s) => {
    if (!useColor) return s;
    const n = parseInt(hex.slice(1), 16);
    return `\x1B[38;2;${n >> 16 & 255};${n >> 8 & 255};${n & 255}m${s}\x1B[39m`;
  }
};
var clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
function pct(n, d) {
  if (d === 0) return "\u2013";
  const v = 100 * n / d;
  return v > 0 && v < 0.1 ? "<0.1%" : `${v.toFixed(v < 10 ? 1 : 0)}%`;
}
function bar(sec, width = 40) {
  if (sec.total === 0) return c.dim("\xB7".repeat(width));
  let out = "";
  let used = 0;
  const entries = Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of entries) {
    const w = Math.max(1, Math.round(n / sec.total * width));
    if (used + w > width) break;
    out += c.hex(agentColor(id), "\u2588".repeat(w));
    used += w;
  }
  return out + c.dim("\u2591".repeat(width - used));
}
function section(title, sec, unit) {
  const lines = [`${c.bold(title)}  ${c.bold(pct(sec.ai, sec.total))} ${c.dim(`(${sec.ai} of ${sec.total} ${unit})`)}`];
  lines.push(`  ${bar(sec)}`);
  const entries = Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of entries) {
    lines.push(`  ${c.hex(agentColor(id), "\u25A0")} ${agentName(id).padEnd(16)} ${String(n).padStart(5)}  ${c.dim(pct(n, sec.total))}`);
  }
  if (sec.capped) lines.push(c.dim(`  read the newest ${sec.total} only (cap reached)`));
  return lines;
}
function render(r, evidence) {
  const from = r.commits.capped && r.commits.oldest ? r.commits.oldest.slice(0, 10) : r.window.since.slice(0, 10);
  const lines = [
    "",
    `${c.bold(clean(r.repo.fullName))}  ${c.dim(`\u2605 ${r.repo.stars.toLocaleString("en-US")} \xB7 ${from} \u2192 ${r.window.until.slice(0, 10)}`)}`,
    "",
    ...section("AI-signed commits", r.commits, "commits"),
    "",
    ...section("AI-signed pull requests", r.pulls, "PRs opened"),
    ""
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
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return void 0;
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
    process.stderr.write(`Not a GitHub repository: ${target ?? "(none)"}
`);
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
      const mins = Math.max(1, Math.ceil((e.resetAt * 1e3 - Date.now()) / 6e4));
      process.stderr.write(`GitHub API rate limit reached. Try again in ${mins} min, or set GITHUB_TOKEN.
`);
    } else if (e instanceof GitHubError && e.status === 404) {
      process.stderr.write(`Repository not found (or private): ${repo}
`);
    } else {
      process.stderr.write(`${clean(e instanceof Error ? e.message : String(e))}
`);
    }
    process.exit(1);
  }
}
main();
