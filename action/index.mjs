// src/action/index.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/core/classify.ts
function createClassifier(reg) {
  const signals = [];
  for (const agent of reg.agents) {
    for (const s of agent.signals) {
      signals.push({ agentId: agent.id, kind: s.kind, re: new RegExp(s.pattern, "im") });
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
  function run2(list, text2, out) {
    if (!text2) return;
    for (const s of list) {
      const m = s.re.exec(text2);
      if (m) out.push({ agentId: s.agentId, kind: s.kind, matched: m[0].trim().slice(0, 120) });
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
    commit(c) {
      const out = [];
      run2(trailer, c.message, out);
      run2(message, c.message, out);
      for (const field of [c.authorLogin, c.authorName, c.authorEmail, c.committerLogin, c.committerName, c.committerEmail]) {
        run2(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out = [];
      run2(prAuthor, p.authorLogin, out);
      run2(prBody, p.body, out);
      run2(prBranch, p.branch, out);
      return dedupe(out);
    },
    isIgnoredCommit(c) {
      if (c.parents > 1) return true;
      const login = (c.authorLogin ?? "").toLowerCase();
      const name = (c.authorName ?? "").toLowerCase();
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
      for (const c of batch) items.push(toCommit(c));
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
function toCommit(c) {
  return {
    sha: c.sha,
    message: c.commit.message ?? "",
    date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
    url: c.html_url,
    authorName: c.commit.author?.name ?? null,
    authorEmail: c.commit.author?.email ?? null,
    authorLogin: c.author?.login ?? null,
    committerName: c.commit.committer?.name ?? null,
    committerEmail: c.commit.committer?.email ?? null,
    committerLogin: c.committer?.login ?? null,
    parents: c.parents?.length ?? 1
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
function parseRepo(input2) {
  const s = input2.trim().replace(/\.git$/, "").replace(/\/+$/, "");
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
  for (const c of items) {
    if (cls.isIgnoredCommit(c)) continue;
    sec.total++;
    if (!sec.oldest || c.date < sec.oldest) sec.oldest = c.date;
    const b = bucket(months, c.date);
    b.total++;
    const matches = cls.commit(c);
    if (matches.length === 0) continue;
    sec.ai++;
    b.ai++;
    const primary = matches[0].agentId;
    sec.byAgent[primary] = (sec.byAgent[primary] ?? 0) + 1;
    b.byAgent[primary] = (b.byAgent[primary] ?? 0) + 1;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0], c.sha.slice(0, 7), firstLine(c.message), c.date, c.url));
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
  return { agentId: m.agentId, kind: m.kind, ref, title, date, url, matched: m.matched };
}
async function fetchRepoData(input2, opts = {}) {
  const fullName = parseRepo(input2);
  if (!fullName) throw new Error(`Not a GitHub repository: ${input2}`);
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
async function analyzeRepo(input2, opts = {}) {
  return buildReport(await fetchRepoData(input2, opts), opts);
}

// src/core/format.ts
function formatShare(n, d) {
  if (d === 0) return "\u2014";
  if (n === 0) return "0%";
  const v = 100 * n / d;
  if (v < 0.1) return "<0.1%";
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(v)}%`;
}
function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[ch]);
}

// src/core/render.ts
var SANS = "-apple-system, BlinkMacSystemFont, &#39;Segoe UI&#39;, Helvetica, Arial, sans-serif";
var MONO = "ui-monospace, &#39;SF Mono&#39;, Menlo, Consolas, monospace";
var PALETTE = {
  dark: { bg: "#101B2C", border: "#35465E", text: "#F2F5FA", muted: "#A8B7CC", accent: "#A4B5FF", none: "#66768B" },
  light: { bg: "#FFFFFF", border: "#C7D1DF", text: "#18263A", muted: "#52627A", accent: "#4056BC", none: "#66768B" }
};
function markGroup(tx, ty, scale, ink, fill) {
  return `<g transform="translate(${tx} ${ty}) scale(${scale})"><circle cx="154" cy="150" r="54" fill="none" stroke="${ink}" stroke-width="30"/><path d="M174 366 338 146" fill="none" stroke="${ink}" stroke-width="36" stroke-linecap="round"/><circle cx="356" cy="362" r="66" fill="none" stroke="${ink}" stroke-width="28"/><path d="M314 362a42 42 0 0 0 84 0Z" fill="${fill}"/></g>`;
}
function text(xp, y, fill, font, size, content, extra = "") {
  return `<text x="${xp}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" ${extra}>${escapeXml(content)}</text>`;
}
function topAgents(sec, n) {
  return Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}
function periodLabel(r) {
  const n = r.commits.total.toLocaleString("en-US");
  if (r.commits.capped && r.commits.oldest) return `since ${r.commits.oldest.slice(0, 10)} \xB7 ${n} commits`;
  return `last ${r.window.days} days \xB7 ${n} commits`;
}
function renderCard(r, theme = "dark") {
  const p = PALETTE[theme];
  const sec = r.commits;
  const share = formatShare(sec.ai, sec.total);
  const agents = topAgents(sec, 3);
  const name = r.repo.fullName.length > 34 ? `${r.repo.fullName.slice(0, 33)}\u2026` : r.repo.fullName;
  const desc = `${share} of ${sec.total} recent commits in ${r.repo.fullName} carry a disclosed AI agent signature (${periodLabel(r)}). ${agents.map(([id, n]) => `${agentName(id)} ${formatShare(n, sec.total)}`).join(", ")}. No signature found does not mean human-only.`;
  const parts = [];
  parts.push(`<rect x="0.5" y="0.5" width="494" height="194" rx="10" fill="${p.bg}" stroke="${p.border}"/>`);
  parts.push(text(22, 31, p.text, MONO, 16, name, `font-weight="600"`));
  parts.push(text(473, 31, p.muted, SANS, 11, r.generatedAt.slice(0, 10), `text-anchor="end"`));
  parts.push(text(20, 98, p.text, MONO, share.length > 4 ? 46 : 54, share, `font-weight="700"`));
  parts.push(text(23, 119, p.muted, SANS, 12, "AI-signed commits"));
  if (agents.length === 0) {
    parts.push(text(236, 89, p.muted, SANS, 12, sec.total === 0 ? "No commits in this period" : "No agent signatures found"));
  }
  agents.forEach(([id, n], i) => {
    const y = 66 + i * 23;
    parts.push(`<rect x="236" y="${y - 9}" width="9" height="9" rx="2" fill="${agentColor(id)}"/>`);
    parts.push(text(253, y, p.text, SANS, 12, agentName(id)));
    parts.push(text(473, y, p.text, MONO, 12, formatShare(n, sec.total), `text-anchor="end"`));
  });
  const bx = 23, by = 133, bw = 449, bh = 10;
  parts.push(`<defs><clipPath id="hm-bar"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5"/></clipPath></defs>`);
  parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5" fill="${p.none}"/>`);
  let cx = bx;
  const segs = [];
  if (sec.total > 0) {
    for (const [id, n] of topAgents(sec, 99)) {
      const w = Math.max(n > 0 ? 2 : 0, n / sec.total * bw);
      segs.push(`<rect x="${cx.toFixed(2)}" y="${by}" width="${w.toFixed(2)}" height="${bh}" fill="${agentColor(id)}"/>`);
      cx += w;
    }
  }
  parts.push(`<g clip-path="url(#hm-bar)">${segs.join("")}</g>`);
  parts.push(text(23, 160, p.muted, MONO, 11, periodLabel(r)));
  parts.push(text(473, 160, p.muted, SANS, 10, `${formatShare(sec.total - sec.ai, sec.total)} no signature found`, `text-anchor="end"`));
  parts.push(text(23, 181, p.muted, SANS, 10, "Disclosed signatures; a lower bound."));
  parts.push(markGroup(379, 155, 0.064453125, p.text, p.accent));
  parts.push(text(412, 178, p.text, SANS, 11, "howmuchai", `font-weight="650"`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-labelledby="hm-t hm-d"><title id="hm-t">${escapeXml(`${r.repo.fullName}: ${share} AI-signed commits`)}</title><desc id="hm-d">${escapeXml(desc)}</desc>${parts.join("")}</svg>`;
}
function textWidth(s) {
  let w = 0;
  for (const ch of s) w += /[il.,:;|!'1]/.test(ch) ? 3.5 : /[mwMW%—]/.test(ch) ? 9.5 : /[A-Z0-9#]/.test(ch) ? 7.5 : 6.5;
  return Math.ceil(w);
}
function renderBadge(r, label = "AI-signed") {
  const value = r ? formatShare(r.commits.ai, r.commits.total) : "\u2014";
  const lw = textWidth(label) + 14;
  const vw = textWidth(value) + 14;
  const w = lw + vw;
  const fill = r && r.commits.total > 0 ? "#4056BC" : "#52627A";
  const title = r ? `${label}: ${value} of recent commits in ${r.repo.fullName}` : `${label}: unavailable`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><clipPath id="hm-r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#hm-r)"><rect width="${lw}" height="20" fill="#34445A"/><rect x="${lw}" width="${vw}" height="20" fill="${fill}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana, ${SANS}" font-size="11">${`<text x="${lw / 2}" y="14">${escapeXml(label)}</text><text x="${lw + vw / 2}" y="14">${escapeXml(value)}</text>`}</g></svg>`;
}

// src/action/index.ts
function input(name, def = "") {
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? def).trim() || def;
}
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
function git(args) {
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
    const rows = Object.entries(r.commits.byAgent).sort((a, b) => b[1] - a[1]).map(([id, n]) => `| ${agentName(id)} | ${n} | ${formatShare(n, r.commits.total)} |`).join("\n");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## howmuchai: ${share} AI-signed commits

${periodLabel(r)} on \`${r.repo.defaultBranch}\`. Pull requests: ${formatShare(r.pulls.ai, r.pulls.total)} (${r.pulls.ai} of ${r.pulls.total}).

| Agent | Commits | Share |
|---|---:|---:|
${rows || "| No signatures found | 0 | 0% |"}

Counts disclosed signatures only, a lower bound. [Method](https://maximilianfeix.github.io/howmuchai/method/)
`
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
