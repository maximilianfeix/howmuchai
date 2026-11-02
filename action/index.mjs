// src/action/index.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/core/classify.ts
function createClassifier(reg) {
  const signals = [];
  for (const agent of reg.agents) {
    for (const s of agent.signals) {
      signals.push({ agentId: agent.id, id: s.id, contains: s.contains ?? null, kind: s.kind, re: new RegExp(s.pattern, "i"), confidence: s.confidence });
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
  const MAX_LINE = 512;
  const MAX_FIELD = 256;
  function lines(text2) {
    if (!text2) return [];
    const out = [];
    let fence = null;
    for (const raw of text2.slice(0, 262144).split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        continue;
      }
      if (fence !== null) continue;
      if (line.length > 0 && line.length <= MAX_LINE) out.push(line);
    }
    return out;
  }
  const MAX_LINES = 400;
  const trailerShape = /^[A-Za-z][A-Za-z-]{1,40}:/;
  function runLines(list, ls, out, kind) {
    const candidates = (kind === "trailer" ? ls.filter((l) => trailerShape.test(l)) : ls).slice(-MAX_LINES);
    const lower = candidates.map((l) => l.toLowerCase());
    for (const s of list) {
      for (let i = 0; i < candidates.length; i++) {
        if (s.contains && !lower[i].includes(s.contains)) continue;
        const m = s.re.exec(candidates[i]);
        if (m) {
          out.push({ agentId: s.agentId, signalId: s.id, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
          break;
        }
      }
    }
  }
  function runField(list, value, out) {
    if (!value || value.length > MAX_FIELD) return;
    for (const s of list) {
      const m = s.re.exec(value);
      if (m) out.push({ agentId: s.agentId, signalId: s.id, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
    }
  }
  const agentOrder = new Map(reg.agents.map((a, i) => [a.id, i]));
  function dedupe(matches) {
    const best = /* @__PURE__ */ new Map();
    for (const m of matches) {
      const cur = best.get(m.agentId);
      if (!cur || cur.confidence === "medium" && m.confidence === "high") best.set(m.agentId, m);
    }
    return [...best.values()].sort(
      (a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) || (agentOrder.get(a.agentId) ?? 1e9) - (agentOrder.get(b.agentId) ?? 1e9)
    );
  }
  return {
    commit(c) {
      const out = [];
      const ls = lines(c.message);
      runLines(trailer, ls, out, "trailer");
      runLines(message, ls, out, "footer");
      for (const field of [c.authorLogin, c.authorName, c.authorEmail, c.committerLogin, c.committerName, c.committerEmail]) {
        runField(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out = [];
      runField(prAuthor, p.authorLogin, out);
      runLines(prBody, lines(p.body), out, "footer");
      runField(prBranch, p.branch, out);
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
  constructor(message, status, resetAt = null, extra = {}) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
    this.name = "GitHubError";
    this.secondary = extra.secondary ?? false;
    this.retryAfter = extra.retryAfter ?? null;
  }
  status;
  resetAt;
  /** True for GitHub's secondary (abuse) rate limits, which clear after a short wait. */
  secondary;
  /** Milliseconds GitHub asked to wait (Retry-After), if any. */
  retryAfter;
};
var AbortedError = class extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
};
var NetworkError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
};
function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1e3;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}
function retryDelay(e, attempt, _nowMs, random) {
  const backoff = Math.min(3e4, 1e3 * 2 ** (attempt - 1)) * (0.5 + random() / 2);
  if (e instanceof NetworkError) return backoff;
  if (!(e instanceof GitHubError)) return null;
  if (e.resetAt) return null;
  if (e.retryAfter !== null && (e.secondary || e.status >= 500 || e.status === 429)) return e.retryAfter;
  if (e.secondary) return Math.max(backoff, 6e4 * (0.5 + random() / 2));
  if (e.status >= 500) return backoff;
  return null;
}
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
    const attempts = this.opts.attempts ?? 4;
    const maxWait = this.opts.maxWaitMs ?? 6e4;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const random = this.opts.random ?? Math.random;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let wait = null;
      try {
        return await this.once(path);
      } catch (e) {
        lastError = e;
        wait = retryDelay(e, attempt, now(), random);
      }
      if (wait === null || attempt === attempts || wait > maxWait) break;
      await sleep(wait);
    }
    throw lastError;
  }
  async once(path) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (!isBrowser) headers["User-Agent"] = this.opts.userAgent ?? "howmuchai";
    if (this.opts.signal?.aborted) throw new AbortedError();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 3e4) : null;
    const onAbort = () => ctrl?.abort();
    this.opts.signal?.addEventListener("abort", onAbort);
    try {
      let res;
      try {
        res = await this.doFetch(`${this.base}${path}`, { headers, signal: ctrl?.signal });
      } catch (e) {
        if (this.opts.signal?.aborted) throw new AbortedError();
        throw new NetworkError(e instanceof Error ? e.message : String(e));
      }
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
        const primary = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
        const secondary = (res.status === 403 || res.status === 429) && !primary && (/secondary rate limit|abuse/i.test(msg) || res.headers.has("retry-after") || res.status === 429);
        throw new GitHubError(msg, res.status, primary ? reset || null : null, {
          secondary,
          retryAfter: parseRetryAfter(res.headers.get("retry-after"), Date.now())
        });
      }
      try {
        return await res.json();
      } catch (e) {
        if (this.opts.signal?.aborted) throw new AbortedError();
        throw new NetworkError(`reading the response failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
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
  /**
   * Commits on the default branch between `since` and `until`, newest first, at most `max`.
   * `capped` is true exactly when more commits exist in the window than were returned.
   */
  async commits(fullName, since, max, until) {
    const items = [];
    const perPage = 100;
    const range = `since=${encodeURIComponent(since)}${until ? `&until=${encodeURIComponent(until)}` : ""}`;
    for (let page = 1; ; page++) {
      let batch;
      try {
        batch = await this.get(`/repos/${fullName}/commits?${range}&per_page=${perPage}&page=${page}`);
      } catch (e) {
        if (e instanceof GitHubError && e.status === 409 && page === 1 && /empty/i.test(e.message)) return { items: [], capped: false };
        throw e;
      }
      for (const c of batch) items.push(toCommit(c));
      if (items.length > max) return { items: items.slice(0, max), capped: true };
      if (batch.length < perPage) return { items, capped: false };
      if (items.length === max) {
        const next = await this.get(`/repos/${fullName}/commits?${range}&per_page=1&page=${max + 1}`);
        return { items, capped: next.length > 0 };
      }
    }
  }
  /** Up to `max` commits from before July 2022 (before coding agents): the repo's own human baseline. */
  async baseline(fullName, max = 100) {
    try {
      const batch = await this.get(`/repos/${fullName}/commits?until=2022-07-01T00:00:00Z&per_page=${Math.min(100, max)}`);
      return batch.map(toCommit);
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 404)) return [];
      throw e;
    }
  }
  /** Agent setup files on the default branch (root, .github, .github/workflows): at most three requests. */
  async agentSetup(fullName) {
    const list = async (dir) => {
      try {
        const items = await this.get(`/repos/${fullName}/contents/${dir}`);
        return Array.isArray(items) ? items.map((i) => dir ? `${dir}/${i.name}` : i.name) : [];
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return [];
        throw e;
      }
    };
    const root = await list("");
    const paths = new Set(root);
    if (paths.has(".github")) {
      for (const p of await list(".github")) paths.add(p);
      if (paths.has(".github/workflows")) for (const p of await list(".github/workflows")) paths.add(p);
    }
    return SETUP_FILES.filter((f) => paths.has(f.path));
  }
  /**
   * Pull requests opened between `since` and `until`, newest first, at most `max`.
   * `capped` is true exactly when more pull requests were opened in the window than were returned.
   */
  async pulls(fullName, since, max, until) {
    const items = [];
    const perPage = 100;
    const sinceMs = Date.parse(since);
    const untilMs = until ? Date.parse(until) : Infinity;
    for (let page = 1; ; page++) {
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
        const t = Date.parse(p.created_at);
        if (t > untilMs) continue;
        if (t < sinceMs) return { items: items.slice(0, max), capped: items.length > max };
        items.push(toPull(p));
        if (items.length > max) return { items: items.slice(0, max), capped: true };
      }
      if (batch.length < perPage) return { items, capped: false };
    }
  }
};
var SETUP_FILES = [
  { path: "CLAUDE.md", agentId: "claude-code" },
  { path: ".claude", agentId: "claude-code" },
  { path: "AGENTS.md", agentId: "codex" },
  { path: ".codex", agentId: "codex" },
  { path: ".cursorrules", agentId: "cursor" },
  { path: ".cursor", agentId: "cursor" },
  { path: "GEMINI.md", agentId: "gemini" },
  { path: ".gemini", agentId: "gemini" },
  { path: ".aider.conf.yml", agentId: "aider" },
  { path: ".aider.chat.history.md", agentId: "aider" },
  { path: ".windsurfrules", agentId: "windsurf" },
  { path: ".clinerules", agentId: "cline" },
  { path: "opencode.json", agentId: "opencode" },
  { path: ".junie", agentId: "junie" },
  { path: ".github/copilot-instructions.md", agentId: "copilot" },
  { path: ".github/workflows/copilot-setup-steps.yml", agentId: "copilot" }
];
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
  version: 5,
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
          id: "claude-code/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*claude\\b[^<\\n]*<noreply@anthropic\\.com>",
          confidence: "high",
          note: 'Added by Claude Code; the name carries the model, e.g. "Claude Opus 5.5 (1M context)"'
        },
        {
          id: "claude-code/footer",
          kind: "commit-message",
          pattern: "^[^\\S\\n]*[_*]{0,2}(?:\u{1F916}[^\\S\\n]*)?generated (?:with|by) \\[?claude code\\]?(?:\\(<?https?://[^)\\s>]+>?\\))?[_*]{0,2}[^\\S\\n]*\\.?[^\\S\\n]*$",
          confidence: "high",
          note: 'Default footer "\u{1F916} Generated with [Claude Code](\u2026)" on a line of its own',
          contains: "generated"
        },
        {
          id: "claude-code/author",
          kind: "commit-author",
          pattern: "^claude\\[bot\\]$|^noreply@anthropic\\.com$",
          confidence: "high",
          note: "Claude GitHub app and Claude Code on the web (account @claude, owned by Anthropic)"
        },
        {
          id: "claude-code/pr-author",
          kind: "pr-author",
          pattern: "^claude(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "claude-code/pr-footer",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*[_*]{0,2}(?:\u{1F916}[^\\S\\n]*)?generated (?:with|by) \\[?claude code\\]?(?:\\(<?https?://[^)\\s>]+>?\\))?[_*]{0,2}[^\\S\\n]*\\.?[^\\S\\n]*$",
          confidence: "high",
          contains: "generated"
        },
        {
          id: "claude-code/pr-branch",
          kind: "pr-branch",
          pattern: "^claude/[^\\s]+$",
          confidence: "medium",
          note: "Default branch prefix of Claude Code on the web and the Claude GitHub app"
        },
        {
          id: "claude-code/session",
          kind: "commit-message",
          pattern: "https://claude\\.ai/code/session_[A-Za-z0-9]{8,}",
          confidence: "high",
          contains: "claude.ai/code/session_",
          note: "Session link added by Claude Code on the web (also as a Claude-Session: trailer)"
        },
        {
          id: "claude-code/pr-session",
          kind: "pr-body",
          pattern: "https://claude\\.ai/code/session_[A-Za-z0-9]{8,}",
          confidence: "high",
          contains: "claude.ai/code/session_"
        },
        {
          id: "claude-code/assisted-by",
          kind: "commit-trailer",
          pattern: "^assisted-by:[ \\t]*claude\\b[^\\n]{0,80}$",
          confidence: "high",
          note: "Assisted-by trailer naming Claude (Linux kernel / LLVM convention)"
        },
        {
          id: "claude-code/pr-trailer",
          kind: "pr-body",
          pattern: "^co-authored-by:[ \\t]*claude\\b[^<\\n]*<noreply@anthropic\\.com>",
          confidence: "high",
          contains: "noreply@anthropic.com",
          note: "Claude Code trailer pasted into the PR description"
        },
        {
          id: "claude-code/pr-assisted-by",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*assisted-by:[ \\t]*claude\\b[^\\n]{0,80}$",
          confidence: "high",
          contains: "assisted-by",
          note: "Assisted-by line in the pull request description"
        }
      ]
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      color: "#4DB8A4",
      signals: [
        {
          id: "copilot/author",
          kind: "commit-author",
          pattern: "^copilot(?:-swe-agent)?(?:\\[bot\\])?$",
          confidence: "high",
          note: "Copilot coding agent"
        },
        {
          id: "copilot/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*copilot\\b[^<\\n]*<(?:\\d+\\+)?copilot@users\\.noreply\\.github\\.com>",
          confidence: "high",
          note: "Added by Copilot in VS Code and on github.com when AI-generated changes are committed"
        },
        {
          id: "copilot/pr-author",
          kind: "pr-author",
          pattern: "^(?:app/)?copilot(?:-swe-agent)?(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "copilot/pr-branch",
          kind: "pr-branch",
          pattern: "^copilot/[^\\s]+$",
          confidence: "medium",
          note: "Default branch prefix of the Copilot coding agent"
        },
        {
          id: "copilot/session",
          kind: "commit-trailer",
          pattern: "^copilot-session:[ \\t]*[0-9a-f]{8}-[0-9a-f-]{8,}$",
          confidence: "high",
          note: "Session trailer added by GitHub Copilot CLI"
        },
        {
          id: "copilot/pr-suffix",
          kind: "pr-body",
          pattern: "<!--[ \\t]*START COPILOT CODING AGENT SUFFIX[ \\t]*-->",
          confidence: "high",
          contains: "copilot coding agent suffix",
          note: "Marker the Copilot coding agent adds to its pull requests"
        },
        {
          id: "copilot/assisted-by",
          kind: "commit-trailer",
          pattern: "^assisted-by:[ \\t]*(?:github[ \\t]+)?copilot\\b[^\\n]{0,80}$",
          confidence: "high"
        },
        {
          id: "copilot/pr-assisted-by",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*assisted-by:[ \\t]*(?:github[ \\t]+)?copilot\\b[^\\n]{0,80}$",
          confidence: "high",
          contains: "assisted-by"
        }
      ]
    },
    {
      id: "codex",
      name: "OpenAI Codex",
      color: "#E6B75A",
      signals: [
        {
          id: "codex/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*\\(codex\\)[^<\\n]*<[^>\\n]+>|^co-authored-by:[ \\t]*codex\\b[^<\\n]*<[^>\\n]+>",
          confidence: "high",
          note: 'Codex CLI, e.g. "gpt-6-astra (Codex) <agent@example.invalid>" or "Codex <noreply@openai.com>"'
        },
        {
          id: "codex/trailer-openai",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<noreply@openai\\.com>",
          confidence: "high"
        },
        {
          id: "codex/pr-author",
          kind: "pr-author",
          pattern: "^chatgpt-codex-connector(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "codex/pr-branch",
          kind: "pr-branch",
          pattern: "^codex/[^\\s]+$",
          confidence: "medium",
          note: "Default branch prefix of Codex cloud tasks"
        },
        {
          id: "codex/assisted-by",
          kind: "commit-trailer",
          pattern: "^assisted-by:[ \\t]*(?:openai[ \\t]+)?codex\\b[^\\n]{0,80}$",
          confidence: "high"
        },
        {
          id: "codex/pr-assisted-by",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*assisted-by:[ \\t]*(?:openai[ \\t]+)?codex\\b[^\\n]{0,80}$",
          confidence: "high",
          contains: "assisted-by"
        },
        {
          id: "codex/task-link",
          kind: "commit-message",
          pattern: "https://chatgpt\\.com/codex/tasks/task_[A-Za-z0-9_]{8,}",
          confidence: "high",
          contains: "chatgpt.com/codex/tasks/",
          note: "Codex cloud task link"
        },
        {
          id: "codex/pr-task-link",
          kind: "pr-body",
          pattern: "https://chatgpt\\.com/codex/tasks/task_[A-Za-z0-9_]{8,}",
          confidence: "high",
          contains: "chatgpt.com/codex/tasks/",
          note: "Codex cloud task link in the PR description"
        }
      ]
    },
    {
      id: "cursor",
      name: "Cursor",
      color: "#D891C8",
      signals: [
        {
          id: "cursor/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<cursoragent@cursor\\.com>",
          confidence: "high",
          note: '"Cursor Agent" or "Cursor"'
        },
        {
          id: "cursor/author",
          kind: "commit-author",
          pattern: "^(?:cursoragent|cursor\\[bot\\])$|^cursoragent@cursor\\.com$",
          confidence: "high"
        },
        {
          id: "cursor/pr-author",
          kind: "pr-author",
          pattern: "^cursor(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "cursor/pr-branch",
          kind: "pr-branch",
          pattern: "^cursor/[^\\s]+$",
          confidence: "medium",
          note: "Default branch prefix of Cursor background agents"
        },
        {
          id: "cursor/pr-footer",
          kind: "pr-body",
          pattern: 'https://cursor\\.com/agents/[A-Za-z0-9-]+\\?[^\\s\\"]*cursor_ref=pr_footer',
          confidence: "high",
          contains: "cursor_ref=pr_footer",
          note: '"Open in Cursor" footer of Cursor agent pull requests'
        },
        {
          id: "cursor/assisted-by",
          kind: "commit-trailer",
          pattern: "^assisted-by:[ \\t]*cursor\\b[^\\n]{0,80}$",
          confidence: "high"
        },
        {
          id: "cursor/pr-marker",
          kind: "pr-body",
          pattern: "<!--[ \\t]*CURSOR_AGENT_PR_BODY_BEGIN[ \\t]*-->",
          confidence: "high",
          contains: "cursor_agent_pr_body_begin",
          note: "Marker Cursor agents put around the pull request description"
        },
        {
          id: "cursor/pr-assisted-by",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*assisted-by:[ \\t]*cursor\\b[^\\n]{0,80}$",
          confidence: "high",
          contains: "assisted-by"
        }
      ]
    },
    {
      id: "devin",
      name: "Devin",
      color: "#62B9DB",
      signals: [
        {
          id: "devin/author",
          kind: "commit-author",
          pattern: "^devin-ai-integration(?:\\[bot\\])?$|^(?:\\d+\\+)?devin-ai-integration\\[bot\\]@users\\.noreply\\.github\\.com$",
          confidence: "high"
        },
        {
          id: "devin/pr-author",
          kind: "pr-author",
          pattern: "^devin-ai-integration(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "devin/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<(?:\\d+\\+)?devin-ai-integration\\[bot\\]@users\\.noreply\\.github\\.com>",
          confidence: "high",
          note: '"Co-Authored-By: Devin AI <\u2026devin-ai-integration[bot]\u2026>"'
        },
        {
          id: "devin/footer",
          kind: "commit-message",
          pattern: "^[^\\S\\n]*[_*]{0,2}generated (?:with|by) \\[devin\\]\\(https://devin\\.ai[^)\\s]*\\)",
          confidence: "high",
          contains: "devin.ai"
        },
        {
          id: "devin/pr-footer",
          kind: "pr-body",
          pattern: "^[^\\S\\n]*[_*]{0,2}generated (?:with|by) \\[devin\\]\\(https://devin\\.ai[^)\\s]*\\)",
          confidence: "high",
          contains: "devin.ai"
        }
      ]
    },
    {
      id: "jules",
      name: "Google Jules",
      color: "#B0BF65",
      signals: [
        {
          id: "jules/author",
          kind: "commit-author",
          pattern: "^google-labs-jules(?:\\[bot\\])?$|^(?:\\d+\\+)?google-labs-jules\\[bot\\]@users\\.noreply\\.github\\.com$",
          confidence: "high"
        },
        {
          id: "jules/pr-author",
          kind: "pr-author",
          pattern: "^google-labs-jules(?:\\[bot\\])?$",
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
          id: "aider/author",
          kind: "commit-author",
          pattern: "^[^\\n]*[^\\s(]\\s\\(aider\\)$",
          confidence: "high",
          note: 'Aider appends " (aider)" to the author name'
        },
        {
          id: "aider/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*aider\\b[^<\\n]*<[^>\\n]+>",
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
          id: "amp/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*amp[ \\t]*<amp@ampcode\\.com>",
          confidence: "high"
        },
        {
          id: "amp/thread",
          kind: "commit-trailer",
          pattern: "^amp-thread(?:-id)?:[ \\t]*https://ampcode\\.com/\\S+",
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
          id: "openhands/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*openhands[ \\t]*<openhands@all-hands\\.dev>",
          confidence: "high"
        },
        {
          id: "openhands/author",
          kind: "commit-author",
          pattern: "^openhands(?:-agent)?(?:\\[bot\\])?$|^openhands@all-hands\\.dev$",
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
          id: "capy/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[^<\\n]*<(?:\\d+\\+)?capy-ai\\[bot\\]@users\\.noreply\\.github\\.com>",
          confidence: "high",
          note: "Capy AI GitHub app (capy.ai)"
        },
        {
          id: "capy/author",
          kind: "commit-author",
          pattern: "^capy-ai(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "capy/pr-author",
          kind: "pr-author",
          pattern: "^capy-ai(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "capy/pr-branch",
          kind: "pr-branch",
          pattern: "^capy/[^\\s]+$",
          confidence: "medium"
        },
        {
          id: "capy/pr-thread",
          kind: "pr-body",
          pattern: "https://capy\\.ai/thread/[A-Za-z0-9_]{8,}",
          confidence: "high",
          contains: "capy.ai/thread/",
          note: "Thread link in Capy pull requests"
        }
      ]
    },
    {
      id: "opencode",
      name: "opencode",
      color: "#7FC7A6",
      signals: [
        {
          id: "opencode/author",
          kind: "commit-author",
          pattern: "^opencode-agent(?:\\[bot\\])?$",
          confidence: "high",
          note: "OpenCode Agent GitHub app (opencode.ai)"
        },
        {
          id: "opencode/pr-author",
          kind: "pr-author",
          pattern: "^opencode-agent(?:\\[bot\\])?$",
          confidence: "high"
        },
        {
          id: "opencode/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*opencode\\b[^<\\n]*<[^>\\n]+>",
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
          id: "junie/trailer",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*junie\\b[^<\\n]*<[^>\\n]*@jetbrains\\.com>",
          confidence: "high",
          note: 'JetBrains Junie, "Co-authored-by: Junie <junie@jetbrains.com>"'
        },
        {
          id: "junie/trailer-name",
          kind: "commit-trailer",
          pattern: "^co-authored-by:[ \\t]*junie\\b[^<\\n]*<[^>\\n]+>",
          confidence: "medium",
          note: "Junie with another address"
        }
      ]
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      color: "#7DA6E8",
      signals: []
    },
    {
      id: "windsurf",
      name: "Windsurf",
      color: "#5EC4C0",
      signals: []
    },
    {
      id: "cline",
      name: "Cline",
      color: "#C7B26A",
      signals: []
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

// src/core/estimate.ts
var mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = Math.imul(s, 1103515245) + 12345 >>> 0) / 2 ** 32;
}
function prevalence(S, H, A, seed = 42, rounds = 400) {
  if (S.length === 0) return null;
  const one = (s, h, a) => {
    const hm = typeof h === "number" ? h : mean(h);
    const am = typeof a === "number" ? a : mean(a);
    if (am - hm < 0.1) return NaN;
    return Math.min(1, Math.max(0, (mean(s) - hm) / (am - hm)));
  };
  const point = one(S, H, A);
  if (Number.isNaN(point)) return null;
  const r = rng(seed);
  const resample = (x) => x.map(() => x[Math.floor(r() * x.length)]);
  const boots = [];
  for (let i = 0; i < rounds; i++) {
    const v = one(resample(S), typeof H === "number" ? H : resample(H), typeof A === "number" ? A : resample(A));
    if (!Number.isNaN(v)) boots.push(v);
  }
  boots.sort((a, b) => a - b);
  return { point, lo: boots[Math.floor(0.05 * (boots.length - 1))] ?? point, hi: boots[Math.ceil(0.95 * (boots.length - 1))] ?? point };
}

// src/core/style-model.json
var style_model_default = {
  version: 1,
  trainedAt: "2026-11-02",
  features: [
    "log subj len",
    "log prose len",
    "has prose",
    "log prose lines",
    "log bullets",
    "log backticks",
    "md bold/heading",
    "conventional",
    "squash (#n)",
    "em dash/arrow",
    "log sentences",
    "long-line share",
    "wrapped<=72",
    "human trailers",
    "lowercase subj",
    "log max line",
    "numbered list",
    "explanatory phrases",
    "two spaces after period",
    "avg word len",
    "first person",
    "informal",
    "identifiers in subject"
  ],
  weights: [
    1.12411,
    0.66518,
    -0.2135,
    0.71841,
    -0.54007,
    -0.0155,
    0.08998,
    0.57347,
    -0.10648,
    0.40837,
    1.61855,
    0.01411,
    -0.07684,
    -0.01374,
    -0.15712,
    -0.07344,
    -0.18056,
    -0.14138,
    -0.02421,
    -0.40346,
    -0.65751,
    -0.06522,
    -0.05286
  ],
  bias: 0.38149,
  mean: [
    3.94286,
    3.39009,
    0.56957,
    1.21851,
    0.44359,
    0.54899,
    0.06565,
    0.29198,
    0.53306,
    0.04231,
    0.77842,
    0.08069,
    0.30228,
    0.08789,
    0.48137,
    2.46698,
    0.0103,
    0.13134,
    982e-5,
    1.08312,
    0.05677,
    537e-5,
    0.15053
  ],
  scale: [
    0.51179,
    3.13249,
    0.49514,
    1.34727,
    0.86293,
    1.18469,
    0.24768,
    0.45467,
    0.49891,
    0.20129,
    1.03193,
    0.22779,
    0.45924,
    0.30543,
    0.49965,
    2.18911,
    0.10094,
    0.33778,
    0.09863,
    0.95477,
    0.2556,
    0.07305,
    0.32805
  ],
  humanMean: 0.2499,
  agentMean: 0.7492
};

// src/core/style.ts
var SIG = /^\s*(co-authored-by|assisted-by|claude-session|copilot-session|amp-thread(-id)?)\s*:/i;
var SIG_TEXT = /generated (with|by)|claude\.ai\/code|🤖|cursor\.com|devin\.ai|capy\.ai|chatgpt\.com\/codex/i;
function stripSignatures(m) {
  return m.slice(0, 65536).split("\n").filter((l) => !SIG.test(l) && !SIG_TEXT.test(l)).join("\n").replace(/^aider: /i, "").replace(/ \(aider\)$/im, "").trim();
}
var strip = stripSignatures;
var TRAILER = /^[A-Za-z][A-Za-z-]{1,40}:\s+\S/;
var HUMAN_TRAILER = /^(reviewed-by|acked-by|tested-by|reported-by|suggested-by|reported-and-tested-by|cc|author|discussion|backpatch-through|link|closes|fixes|bug|signed-off-by|change-id|bug-url|pr-url|reviewed-on)\s*:/i;
function features(raw) {
  const m = strip(raw);
  const lines = m.split("\n");
  const subj = lines[0] ?? "";
  const rest = lines.slice(1);
  const trailers = rest.filter((l) => TRAILER.test(l.trim()));
  const prose = rest.filter((l) => l.trim() && !TRAILER.test(l.trim()) && !/^\s*(https?:\/\/|\[\d+\]|>)/.test(l));
  const body = prose.join("\n");
  const l1 = (x) => Math.log1p(x);
  const words = body.split(/\s+/).filter(Boolean);
  return [
    l1(subj.length),
    l1(body.length),
    +(prose.length > 0),
    l1(prose.length),
    l1((body.match(/^\s*[-*•] /gm) ?? []).length),
    l1((m.match(/`/g) ?? []).length),
    +/\*\*[^*]+\*\*|^#{1,3} /m.test(body),
    +/^(feat|fix|chore|docs|refactor|test|tests|ci|perf|build|style)(\([^)]+\))?!?: /.test(subj),
    +/\(#\d+\)$/.test(subj),
    +/[—→]/.test(m),
    l1((body.match(/[.!?](\s|$)/g) ?? []).length),
    prose.length ? Math.min(1, prose.filter((l) => l.length > 76).length / prose.length) : 0,
    prose.length ? +prose.every((l) => l.length <= 72) : 0,
    l1(trailers.filter((l) => HUMAN_TRAILER.test(l.trim())).length),
    +/^[a-z]/.test(subj),
    l1(prose.reduce((mx, l) => l.length > mx ? l.length : mx, 0)),
    +/^\s*\d+\.\s/m.test(body),
    +/\b(this (change|commit|pr|patch)|so that|instead of|which means)\b/i.test(body),
    +/[a-z]\.  [A-Z]/.test(m),
    // two spaces after a full stop
    words.length ? l1(words.reduce((s, w) => s + w.length, 0) / words.length) : 0,
    l1((body.match(/\b(we|I|I'm|I've|we're|let's)\b/g) ?? []).length),
    // first person
    +/[!?]{2,}|:\)|;\)|\blol\b|\bhmm\b/i.test(m),
    l1((subj.match(/[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]+|\w+\(\)/g) ?? []).length)
    // identifiers in subject
  ];
}
function isJudgeable(message) {
  const m = stripSignatures(message);
  return m.length >= 40 || m.split("\n").filter((l) => l.trim()).length >= 2;
}
function score(model, message) {
  const x = features(message);
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * ((x[i] - model.mean[i]) / model.scale[i]);
  return 1 / (1 + Math.exp(-z));
}

// src/core/analyze.ts
var styleModel = style_model_default;
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
  return { fetched: 0, total: 0, ai: 0, byAgent: {}, hints: 0, hintsByAgent: {}, byMonth: [], evidence: [], capped: false, oldest: null };
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
function count(sec, b, matches) {
  const first = matches[0];
  if (!first) return false;
  if (first.confidence === "high") {
    sec.ai++;
    b.ai++;
    sec.byAgent[first.agentId] = (sec.byAgent[first.agentId] ?? 0) + 1;
    b.byAgent[first.agentId] = (b.byAgent[first.agentId] ?? 0) + 1;
  } else {
    sec.hints++;
    sec.hintsByAgent[first.agentId] = (sec.hintsByAgent[first.agentId] ?? 0) + 1;
  }
  return true;
}
function summarizeCommits(items, cls, evidenceLimit) {
  const sec = emptySection();
  const months = /* @__PURE__ */ new Map();
  sec.fetched = items.length;
  for (const c of items) {
    if (cls.isIgnoredCommit(c)) continue;
    sec.total++;
    if (!sec.oldest || c.date < sec.oldest) sec.oldest = c.date;
    const b = bucket(months, c.date);
    b.total++;
    const matches = cls.commit(c);
    if (!count(sec, b, matches)) continue;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0], c.sha.slice(0, 7), firstLine(c.message), c.date, c.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}
function summarizePulls(items, cls, evidenceLimit) {
  const sec = emptySection();
  const months = /* @__PURE__ */ new Map();
  sec.fetched = items.length;
  for (const p of items) {
    if (cls.isIgnoredPull(p)) continue;
    sec.total++;
    if (!sec.oldest || p.createdAt < sec.oldest) sec.oldest = p.createdAt;
    const b = bucket(months, p.createdAt);
    b.total++;
    const matches = cls.pull(p);
    if (!count(sec, b, matches)) continue;
    if (sec.evidence.length < evidenceLimit) sec.evidence.push(toEvidence(matches[0], `#${p.number}`, p.title.slice(0, 140), p.createdAt, p.url));
  }
  sec.byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return sec;
}
function toEvidence(m, ref, title, date, url) {
  return { agentId: m.agentId, signalId: m.signalId, kind: m.kind, ref, title, date, url, matched: m.matched, confidence: m.confidence };
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
    client.commits(repo.fullName, since, opts.maxCommits ?? DEFAULTS.maxCommits, now.toISOString()),
    client.pulls(repo.fullName, since, opts.maxPulls ?? DEFAULTS.maxPulls, now.toISOString())
  ]);
  const data = { repo, commits, pulls, since, until: now.toISOString(), days, baseline: null, setup: null };
  if (opts.beyond !== false) {
    const optional = async (f) => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        return null;
      }
    };
    data.setup = await optional(() => client.agentSetup(repo.fullName));
    const cls = createClassifier(registry);
    const disclosed = commits.items.filter((c) => !cls.isIgnoredCommit(c) && cls.commit(c).some((m) => m.confidence === "high")).length;
    if (disclosed >= GATE_DISCLOSED || (data.setup?.length ?? 0) > 0) data.baseline = await optional(() => client.baseline(repo.fullName));
  }
  return data;
}
var GATE_DISCLOSED = 5;
var AGENT_ACCOUNT = /\[bot\]$|^(copilot|cursoragent|claude|devin-ai-integration|google-labs-jules|openhands(-agent)?|opencode-agent|capy-ai)$/i;
var MIN_JUDGEABLE = 20;
function beyondSignatures(d, cls) {
  const items = d.commits.items.filter((c) => !cls.isIgnoredCommit(c));
  const signed = /* @__PURE__ */ new Set();
  for (const c of items) if (cls.commit(c).some((m) => m.confidence === "high")) signed.add(c);
  const loginByEmail = /* @__PURE__ */ new Map();
  for (const c of items) if (c.authorLogin && c.authorEmail) loginByEmail.set(c.authorEmail.toLowerCase(), c.authorLogin.toLowerCase());
  const who = (c) => {
    const login = c.authorLogin?.toLowerCase() ?? (c.authorEmail ? loginByEmail.get(c.authorEmail.toLowerCase()) : void 0);
    if (login) return AGENT_ACCOUNT.test(login) ? null : `@${login}`;
    if (c.authorEmail) return `<${c.authorEmail.toLowerCase()}>`;
    return null;
  };
  const people = items.filter((c) => who(c) !== null);
  const aiAuthors = new Set([...signed].map(who).filter((x) => x !== null));
  const beyond = {
    setup: d.setup ?? null,
    authors: { aiAuthors: aiAuthors.size, authors: new Set(people.map(who)).size, commitsByAiAuthors: people.filter((c) => aiAuthors.has(who(c))).length },
    estimate: null,
    likely: null,
    reason: null,
    model: styleModel.version
  };
  if (items.length === 0) return { ...beyond, reason: "no-commits" };
  const gate = signed.size >= GATE_DISCLOSED ? "disclosed" : (d.setup?.length ?? 0) > 0 ? "setup" : null;
  if (!gate) return { ...beyond, reason: "no-evidence" };
  const undisclosed = items.filter((c) => !signed.has(c));
  const judged = undisclosed.filter((c) => isJudgeable(c.message));
  const short = undisclosed.length - judged.length;
  if (judged.length < MIN_JUDGEABLE) return { ...beyond, reason: undisclosed.length === 0 ? "all-disclosed" : "too-few-judgeable" };
  const S = judged.map((c) => score(styleModel, c.message));
  const ownHuman = (d.baseline ?? []).filter((c) => !cls.isIgnoredCommit(c) && isJudgeable(c.message));
  const H = ownHuman.length >= 30 ? ownHuman.map((c) => score(styleModel, c.message)) : styleModel.humanMean;
  const signedJudged = [...signed].filter((c) => isJudgeable(c.message));
  const A = signedJudged.length >= 10 ? signedJudged.map((c) => score(styleModel, c.message)) : styleModel.agentMean;
  const p = prevalence(S, H, A);
  if (!p) return { ...beyond, reason: "inseparable" };
  beyond.estimate = {
    ...p,
    gate,
    humanReference: typeof H === "number" ? "training" : "own-history",
    aiReference: typeof A === "number" ? "training" : "repo",
    tooShort: short
  };
  const n = items.length;
  beyond.likely = {
    point: (signed.size + p.point * undisclosed.length) / n,
    lo: (signed.size + p.lo * judged.length) / n,
    hi: (signed.size + p.hi * undisclosed.length) / n
  };
  return beyond;
}
function buildReport(d, opts = {}) {
  const evidenceLimit = opts.evidenceLimit ?? DEFAULTS.evidenceLimit;
  const cls = createClassifier(registry);
  const cSec = summarizeCommits(d.commits.items, cls, evidenceLimit);
  cSec.capped = d.commits.capped;
  const pSec = summarizePulls(d.pulls.items, cls, evidenceLimit);
  pSec.capped = d.pulls.capped;
  return {
    schema: 2,
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
    beyond: beyondSignatures(d, cls),
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
var SANS = "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, Fira Sans, sans-serif";
var MONO = "ui-monospace, SF Mono, Menlo, Consolas, IBM Plex Mono, monospace";
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
function coverageLabel(sec, r, unit) {
  const n = sec.total.toLocaleString("en-US");
  if (sec.total === 0 && !sec.capped) return `no ${unit} in the last ${r.window.days} days`;
  if (sec.capped && sec.oldest) return `newest ${n} ${unit}, since ${sec.oldest.slice(0, 10)}`;
  return `${n} ${unit}, last ${r.window.days} days`;
}
function periodLabel(r) {
  return coverageLabel(r.commits, r, "commits");
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

${periodLabel(r)} on \`${r.repo.defaultBranch}\`. Pull requests: ${formatShare(r.pulls.ai, r.pulls.total)} (${r.pulls.ai} of ${coverageLabel(r.pulls, r, "pull requests")}).

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
    const files = ["card-dark.svg", "card-light.svg", "badge.svg", "report.json"].map((f) => join(dir, f));
    git(["add", "--", ...files]);
    try {
      execFileSync("git", ["diff", "--cached", "--quiet", "--", ...files]);
      console.log("No changes to commit");
    } catch {
      git(["commit", "-m", `chore(howmuchai): ${share} AI-signed commits`, "--", ...files]);
      git(["push"]);
    }
  }
}
run().catch((e) => {
  console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
