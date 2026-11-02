#!/usr/bin/env node

// src/core/classify.ts
function createClassifier(reg) {
  const signals = [];
  for (const agent of reg.agents) {
    for (const s of agent.signals) {
      signals.push({ agentId: agent.id, id: s.id, contains: s.contains ?? null, kind: s.kind, re: new RegExp(s.pattern, "i"), confidence: s.confidence });
    }
  }
  const ignored = new Set(reg.ignoredAuthors.map((a) => a.toLowerCase()));
  const depBot = /^(renovate|dependabot|mend|whitesource|snyk|greenkeeper|depfu|pyup|scala-steward|release-please|changeset|semantic-release)[\w.-]*(\[bot\])?$/i;
  const of = (kind) => signals.filter((s) => s.kind === kind);
  const trailer = of("commit-trailer");
  const message = of("commit-message");
  const author = of("commit-author");
  const prAuthor = of("pr-author");
  const prBody = of("pr-body");
  const prBranch = of("pr-branch");
  const MAX_LINE = 512;
  const MAX_FIELD = 256;
  function lines(text) {
    if (!text) return [];
    const out = [];
    let fence = null;
    for (const raw of text.slice(0, 262144).split("\n")) {
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
    commit(c2) {
      const out = [];
      const ls = lines(c2.message);
      runLines(trailer, ls, out, "trailer");
      runLines(message, ls, out, "footer");
      for (const field of [c2.authorLogin, c2.authorName, c2.authorEmail, c2.committerLogin, c2.committerName, c2.committerEmail]) {
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
    isIgnoredCommit(c2) {
      if (c2.parents > 1) return true;
      const login = (c2.authorLogin ?? "").toLowerCase();
      const name = (c2.authorName ?? "").toLowerCase();
      return ignored.has(login) || ignored.has(name) || depBot.test(login) || depBot.test(name);
    },
    isIgnoredPull(p) {
      const login = (p.authorLogin ?? "").toLowerCase();
      return ignored.has(login) || depBot.test(login);
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
      for (const c2 of batch) items.push(toCommit(c2));
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
    mergeCommitSha: p.merge_commit_sha ?? null,
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
function prevalence(S, H, A, seed = 42, rounds = 400, minGap = 0.1) {
  if (S.length === 0) return null;
  const one = (s, h, a, gap) => {
    const hm = typeof h === "number" ? h : mean(h);
    const am = typeof a === "number" ? a : mean(a);
    if (!(am - hm > gap)) return NaN;
    return Math.min(1, Math.max(0, (mean(s) - hm) / (am - hm)));
  };
  const point = one(S, H, A, minGap - 1e-12);
  if (Number.isNaN(point)) return null;
  const r = rng(seed);
  const resample = (x) => x.map(() => x[Math.floor(r() * x.length)]);
  const boots = [];
  let unidentifiable = 0;
  for (let i = 0; i < rounds; i++) {
    const v = one(resample(S), typeof H === "number" ? H : resample(H), typeof A === "number" ? A : resample(A), 1e-6);
    if (Number.isNaN(v)) unidentifiable++;
    else boots.push(v);
  }
  if (unidentifiable > 0.05 * rounds) return { point, lo: 0, hi: 1 };
  boots.sort((a, b) => a - b);
  return { point, lo: boots[Math.floor(0.05 * (boots.length - 1))] ?? point, hi: boots[Math.ceil(0.95 * (boots.length - 1))] ?? point };
}

// src/core/style-model.json
var style_model_default = {
  version: 2,
  trainedAt: "2026-11-02",
  features: [
    "log subject length (without prefix)",
    "log prose length",
    "log prose lines",
    "log bullets",
    "log backticks",
    "markdown bold/heading",
    "em dash/arrow",
    "log sentences",
    "long-line share",
    "wrapped at 72",
    "human review trailers",
    "log longest line",
    "numbered list",
    "explanatory phrases",
    "two spaces after a full stop",
    "average word length",
    "first person",
    "informal",
    "identifiers in subject"
  ],
  weights: [
    0.92682,
    0.64821,
    0.72756,
    -0.49838,
    -0.01125,
    0.12157,
    0.41355,
    1.57411,
    0.03238,
    -0.13282,
    -0.08048,
    -0.16266,
    -0.16342,
    -0.15175,
    -0.04372,
    -0.52831,
    -0.68795,
    -0.05423,
    -0.12757
  ],
  bias: 0.41991,
  mean: [
    3.76305,
    3.39044,
    1.21868,
    0.44373,
    0.54917,
    0.06568,
    0.04232,
    0.77867,
    0.08072,
    0.30205,
    0.08792,
    2.46703,
    0.0103,
    0.13139,
    983e-5,
    1.08295,
    0.05679,
    537e-5,
    0.14622
  ],
  scale: [
    0.52562,
    3.13294,
    1.34746,
    0.86304,
    1.18484,
    0.24771,
    0.20132,
    1.032,
    0.22783,
    0.45915,
    0.30548,
    2.18947,
    0.10096,
    0.33782,
    0.09865,
    0.95487,
    0.25564,
    0.07306,
    0.32422
  ],
  humanMean: 0.3608,
  agentMean: 0.8439,
  trainedOn: {
    agent: 14554,
    human: 13021,
    repos: 152
  }
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
  const subj = (lines[0] ?? "").replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/\s*\(#\d+\)$/, "");
  const rest = lines.slice(1);
  const trailers = rest.filter((l) => TRAILER.test(l.trim()));
  const prose = rest.filter((l) => l.trim() && !TRAILER.test(l.trim()) && !/^\s*(https?:\/\/|\[\d+\]|>)/.test(l));
  const body = prose.join("\n");
  const l1 = (x) => Math.log1p(x);
  const words = body.split(/\s+/).filter(Boolean);
  return [
    l1(subj.length),
    l1(body.length),
    l1(prose.length),
    l1((body.match(/^\s*[-*•] /gm) ?? []).length),
    l1((m.match(/`/g) ?? []).length),
    +/\*\*[^*]+\*\*|^#{1,3} /m.test(body),
    +/[—→]/.test(m),
    l1((body.match(/[.!?](\s|$)/g) ?? []).length),
    prose.length ? Math.min(1, prose.filter((l) => l.length > 76).length / prose.length) : 0,
    prose.length ? +prose.every((l) => l.length <= 72) : 0,
    l1(trailers.filter((l) => HUMAN_TRAILER.test(l.trim())).length),
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
  const rest = stripSignatures(message).split("\n").slice(1);
  return rest.some((l) => l.trim().length >= 20 && !TRAILER.test(l.trim()));
}
function score(model, message) {
  const x = features(message);
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * ((x[i] - model.mean[i]) / model.scale[i]);
  return 1 / (1 + Math.exp(-z));
}

// src/core/analyze.ts
var styleModel = style_model_default;
var VERSION = "0.2.0";
var DEFAULTS = { days: 90, maxCommits: 500, maxPulls: 300, evidenceLimit: 40 };
function parseRepo(input) {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
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
var LINK_DAYS = 2;
function linkedPull(c2, pulls) {
  const m = /\(#(\d{1,9})\)\s*$/.exec(c2.message.split("\n", 1)[0] ?? "");
  if (!m) return null;
  const p = pulls.get(Number(m[1]));
  if (!p || !p.mergedAt) return null;
  if (p.mergeCommitSha) return p.mergeCommitSha === c2.sha ? p : null;
  const dt = Math.abs(Date.parse(c2.date) - Date.parse(p.mergedAt));
  return Number.isFinite(dt) && dt <= LINK_DAYS * 864e5 ? p : null;
}
function commitMatches(c2, cls, pulls) {
  const own = cls.commit(c2);
  if (own.some((m) => m.confidence === "high")) return { matches: own, viaPull: null };
  const p = linkedPull(c2, pulls);
  if (p && !cls.isIgnoredPull(p)) {
    const pm = cls.pull(p).filter((m) => m.confidence === "high");
    if (pm.length) return { matches: [...pm, ...own], viaPull: p.number };
  }
  return { matches: own, viaPull: null };
}
function pullIndex(pulls) {
  return new Map(pulls.map((p) => [p.number, p]));
}
function summarizeCommits(items, cls, evidenceLimit, pulls = /* @__PURE__ */ new Map()) {
  const sec = emptySection();
  const months = /* @__PURE__ */ new Map();
  sec.fetched = items.length;
  for (const c2 of items) {
    if (cls.isIgnoredCommit(c2)) continue;
    sec.total++;
    if (!sec.oldest || c2.date < sec.oldest) sec.oldest = c2.date;
    const b = bucket(months, c2.date);
    b.total++;
    const { matches, viaPull } = commitMatches(c2, cls, pulls);
    if (!count(sec, b, matches)) continue;
    if (sec.evidence.length < evidenceLimit) {
      const e = toEvidence(matches[0], c2.sha.slice(0, 7), firstLine(c2.message), c2.date, c2.url);
      if (viaPull !== null) {
        e.viaPull = viaPull;
        e.matched = `PR #${viaPull}: ${e.matched}`;
      }
      sec.evidence.push(e);
    }
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
async function fetchRepoData(input, opts = {}) {
  const fullName = parseRepo(input);
  if (!fullName) throw new Error(`Not a GitHub repository: ${input}`);
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
    const prs = pullIndex(pulls.items);
    const disclosed = commits.items.filter((c2) => !cls.isIgnoredCommit(c2) && commitMatches(c2, cls, prs).matches.some((m) => m.confidence === "high")).length;
    if (disclosed >= GATE_DISCLOSED) data.baseline = await optional(() => client.baseline(repo.fullName));
  }
  return data;
}
var GATE_DISCLOSED = 10;
var AGENT_ACCOUNT = /\[bot\]$|^(copilot|cursoragent|claude|devin-ai-integration|google-labs-jules|openhands(-agent)?|opencode-agent|capy-ai)$/i;
var MAX_RANGE = 0.5;
var MIN_JUDGEABLE = 20;
function beyondSignatures(d, cls) {
  const items = d.commits.items.filter((c2) => !cls.isIgnoredCommit(c2));
  const signed = /* @__PURE__ */ new Set();
  const prs = pullIndex(d.pulls.items);
  for (const c2 of items) if (commitMatches(c2, cls, prs).matches.some((m) => m.confidence === "high")) signed.add(c2);
  const loginByEmail = /* @__PURE__ */ new Map();
  for (const c2 of items) if (c2.authorLogin && c2.authorEmail) loginByEmail.set(c2.authorEmail.toLowerCase(), c2.authorLogin.toLowerCase());
  const who = (c2) => {
    const login = c2.authorLogin?.toLowerCase() ?? (c2.authorEmail ? loginByEmail.get(c2.authorEmail.toLowerCase()) : void 0);
    if (login) return AGENT_ACCOUNT.test(login) ? null : `@${login}`;
    if (c2.authorEmail) return `<${c2.authorEmail.toLowerCase()}>`;
    return null;
  };
  const people = items.filter((c2) => who(c2) !== null);
  const aiAuthors = new Set([...signed].map(who).filter((x) => x !== null));
  const beyond = {
    setup: d.setup ?? null,
    authors: { aiAuthors: aiAuthors.size, authors: new Set(people.map(who)).size, commitsByAiAuthors: people.filter((c2) => aiAuthors.has(who(c2))).length },
    estimate: null,
    likely: null,
    reason: null,
    model: styleModel.version
  };
  if (items.length === 0) return { ...beyond, reason: "no-commits" };
  if (signed.size < GATE_DISCLOSED) return { ...beyond, reason: (d.setup?.length ?? 0) > 0 ? "setup-only" : "no-evidence" };
  const gate = "disclosed";
  const isBot = (c2) => /\[bot\]$/i.test(c2.authorLogin ?? "") || /\[bot\]$/i.test(c2.authorName ?? "");
  const unsigned = items.filter((c2) => !signed.has(c2));
  const undisclosed = unsigned.filter((c2) => !isBot(c2));
  const bots = unsigned.length - undisclosed.length;
  const judged = undisclosed.filter((c2) => isJudgeable(c2.message));
  const short = undisclosed.length - judged.length;
  if (judged.length < MIN_JUDGEABLE) return { ...beyond, reason: undisclosed.length === 0 ? "all-disclosed" : "too-few-judgeable" };
  const S = judged.map((c2) => score(styleModel, c2.message));
  const signedJudged = [...signed].filter((c2) => isJudgeable(c2.message));
  if (signedJudged.length < GATE_DISCLOSED) return { ...beyond, reason: "too-few-disclosed" };
  const A = signedJudged.map((c2) => score(styleModel, c2.message));
  const history = (d.baseline ?? []).filter((c2) => !cls.isIgnoredCommit(c2) && !isBot(c2));
  const ownHuman = history.filter((c2) => isJudgeable(c2.message));
  let H;
  if (ownHuman.length >= 30) H = ownHuman.map((c2) => score(styleModel, c2.message));
  else if (d.baseline && d.baseline.length === 0) H = styleModel.humanMean;
  else return { ...beyond, reason: "too-little-history" };
  const p = prevalence(S, H, A, 42, 400, 0.2);
  if (!p) return { ...beyond, reason: "inseparable" };
  const n = items.length;
  const likely = {
    point: (signed.size + p.point * undisclosed.length) / n,
    lo: (signed.size + p.lo * judged.length) / n,
    hi: (signed.size + p.hi * judged.length + short) / n
  };
  if (p.hi - p.lo > MAX_RANGE || likely.hi - likely.lo > MAX_RANGE) return { ...beyond, reason: "too-uncertain" };
  beyond.estimate = {
    ...p,
    gate,
    humanReference: typeof H === "number" ? "training" : "own-history",
    aiReference: typeof A === "number" ? "training" : "repo",
    tooShort: short,
    judged: judged.length,
    bots
  };
  beyond.likely = likely;
  return beyond;
}
function buildReport(d, opts = {}) {
  const evidenceLimit = opts.evidenceLimit ?? DEFAULTS.evidenceLimit;
  const cls = createClassifier(registry);
  const cSec = summarizeCommits(d.commits.items, cls, evidenceLimit, pullIndex(d.pulls.items));
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
async function analyzeRepo(input, opts = {}) {
  return buildReport(await fetchRepoData(input, opts), opts);
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
function formatRange(lo, hi) {
  const a = Math.round(lo * 100);
  const b = Math.round(hi * 100);
  return a === b ? `${a}%` : `${a}\u2013${b}%`;
}
var NO_ESTIMATE = {
  "no-evidence": "this repo discloses fewer than 10 agent commits, and without that a number would be a guess",
  "setup-only": "the repo has agent setup files but discloses fewer than 10 agent commits; setup files show that agents are used, not how much, and some human commit styles look like agent text",
  "too-few-disclosed": "fewer than 10 disclosed agent commits have a message long enough to show what agent work looks like here",
  "too-little-history": "the repo has too few commits from before July 2022 to show what human work looks like here",
  "all-disclosed": "every commit already carries a signature",
  "too-few-judgeable": "fewer than 20 undisclosed commits have a message long enough to judge",
  inseparable: "this repo's human and agent commits cannot be told apart by style",
  "too-uncertain": "the possible range would be wider than 50 percentage points",
  "no-commits": "there are no commits in this period"
};
function noEstimateReason(reason) {
  return NO_ESTIMATE[reason ?? "no-evidence"] ?? NO_ESTIMATE["no-evidence"];
}

// src/core/dataset.ts
function reportPath(fullName) {
  return `data/repos/${fullName.toLowerCase()}.json`;
}
function pagePath(fullName) {
  return `r/${fullName.toLowerCase()}/`;
}

// src/core/render.ts
function coverageLabel(sec, r, unit) {
  const n = sec.total.toLocaleString("en-US");
  if (sec.total === 0 && !sec.capped) return `no ${unit} in the last ${r.window.days} days`;
  if (sec.capped && sec.oldest) return `newest ${n} ${unit}, since ${sec.oldest.slice(0, 10)}`;
  return `${n} ${unit}, last ${r.window.days} days`;
}

// src/core/types.ts
var REPORT_SCHEMA = 2;

// src/core/validate.ts
var REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
var GH_URL = /^https:\/\/github\.com\//;
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
var isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
function counts(map, path, errors) {
  if (!isObj(map)) {
    errors.push(`${path} is not an object`);
    return 0;
  }
  let sum = 0;
  for (const [k, v] of Object.entries(map)) {
    if (!/^[a-z0-9-]+$/.test(k)) errors.push(`${path} has a bad agent id ${JSON.stringify(k)}`);
    if (!isCount(v)) errors.push(`${path}.${k} is not a count`);
    else sum += v;
  }
  return sum;
}
function checkEvidence(ev, path, errors) {
  if (!Array.isArray(ev)) return errors.push(`${path} is not a list`);
  ev.forEach((e, i) => {
    if (!isObj(e)) return errors.push(`${path}[${i}] is not an object`);
    const x = e;
    if (typeof x.url !== "string" || !GH_URL.test(x.url)) errors.push(`${path}[${i}].url is not a github.com link`);
    for (const f of ["agentId", "kind", "ref", "title", "matched"]) if (typeof x[f] !== "string") errors.push(`${path}[${i}].${f} missing`);
  });
}
function checkSection(s, path, errors) {
  if (!isObj(s)) return errors.push(`${path} missing`);
  const x = s;
  for (const f of ["fetched", "total", "ai", "hints"]) if (!isCount(x[f])) errors.push(`${path}.${f} is not a count`);
  if (isCount(x.total) && isCount(x.ai) && x.ai > x.total) errors.push(`${path}.ai is larger than total`);
  if (isCount(x.total) && isCount(x.fetched) && x.total > x.fetched) errors.push(`${path}.total is larger than fetched`);
  if (isCount(x.ai) && counts(x.byAgent, `${path}.byAgent`, errors) !== x.ai) errors.push(`${path}.byAgent does not add up to ai`);
  if (isCount(x.hints) && counts(x.hintsByAgent, `${path}.hintsByAgent`, errors) !== x.hints) errors.push(`${path}.hintsByAgent does not add up to hints`);
  if (typeof x.capped !== "boolean") errors.push(`${path}.capped is not a boolean`);
  if (x.oldest !== null && !isDate(x.oldest)) errors.push(`${path}.oldest is not a date`);
  if (!Array.isArray(x.byMonth)) errors.push(`${path}.byMonth is not a list`);
  else {
    let total = 0;
    let ai = 0;
    for (const m of x.byMonth) {
      if (!isObj(m) || typeof m.month !== "string" || !/^\d{4}-\d{2}$/.test(m.month) || !isCount(m.total) || !isCount(m.ai)) {
        errors.push(`${path}.byMonth has a bad entry`);
        continue;
      }
      if (counts(m.byAgent, `${path}.byMonth[${m.month}].byAgent`, errors) !== m.ai) errors.push(`${path}.byMonth[${m.month}].byAgent does not add up`);
      total += m.total;
      ai += m.ai;
    }
    if (isCount(x.total) && total !== x.total) errors.push(`${path}.byMonth totals do not add up`);
    if (isCount(x.ai) && ai !== x.ai) errors.push(`${path}.byMonth AI counts do not add up`);
  }
  checkEvidence(x.evidence, `${path}.evidence`, errors);
}
var isShare = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function checkRange(x, path, errors) {
  if (!isObj(x) || !isShare(x.point) || !isShare(x.lo) || !isShare(x.hi)) return errors.push(`${path} is not a share range`);
  if (!(x.lo <= x.point + 1e-9 && x.point <= x.hi + 1e-9)) errors.push(`${path} is not ordered lo \u2264 point \u2264 hi`);
}
function checkBeyond(b, errors) {
  if (!isObj(b)) return errors.push("beyond is not an object");
  if (b.setup !== null && !(Array.isArray(b.setup) && b.setup.every((s) => isObj(s) && typeof s.path === "string" && typeof s.agentId === "string"))) errors.push("beyond.setup is invalid");
  const a = b.authors;
  if (!isObj(a) || !isCount(a.aiAuthors) || !isCount(a.authors) || !isCount(a.commitsByAiAuthors) || a.aiAuthors > a.authors) errors.push("beyond.authors is invalid");
  if (b.estimate !== null) {
    checkRange(b.estimate, "beyond.estimate", errors);
    const e = b.estimate;
    if (isObj(e) && (!["disclosed", "setup"].includes(e.gate) || !isCount(e.tooShort) || e.judged !== void 0 && !isCount(e.judged) || e.bots !== void 0 && !isCount(e.bots))) errors.push("beyond.estimate fields are invalid");
  }
  if (b.likely !== null) checkRange(b.likely, "beyond.likely", errors);
  if (b.reason !== void 0 && b.reason !== null && !["no-commits", "no-evidence", "setup-only", "too-few-disclosed", "too-little-history", "all-disclosed", "too-few-judgeable", "inseparable", "too-uncertain"].includes(b.reason)) errors.push("beyond.reason is unknown");
}
function validateReport(v) {
  const errors = [];
  if (!isObj(v)) return { ok: false, errors: ["not an object"] };
  const r = v;
  if (r.schema !== REPORT_SCHEMA) errors.push(`schema ${String(r.schema)} is not ${REPORT_SCHEMA}`);
  if (!isObj(r.repo) || typeof r.repo.fullName !== "string" || !REPO.test(r.repo.fullName)) errors.push("repo.fullName is not owner/repo");
  else {
    if (typeof r.repo.url !== "string" || !GH_URL.test(r.repo.url)) errors.push("repo.url is not a github.com link");
    if (!isCount(r.repo.stars)) errors.push("repo.stars is not a count");
  }
  if (!isObj(r.window) || !isDate(r.window.since) || !isDate(r.window.until) || !isCount(r.window.days)) errors.push("window is invalid");
  else if (Date.parse(r.window.since) > Date.parse(r.window.until)) errors.push("window starts after it ends");
  if (!isDate(r.generatedAt)) errors.push("generatedAt is not a date");
  else if (Date.parse(r.generatedAt) > Date.now() + 36e5) errors.push("generatedAt is in the future");
  checkSection(r.commits, "commits", errors);
  checkSection(r.pulls, "pulls", errors);
  if (r.beyond !== void 0) checkBeyond(r.beyond, errors);
  if (isObj(r.commits) && isCount(r.commits.total) && isCount(r.commits.ai)) {
    const want = r.commits.total > 0 ? r.commits.ai / r.commits.total : null;
    if (r.share !== want && !(typeof r.share === "number" && want !== null && Math.abs(r.share - want) < 1e-9)) errors.push("share does not match ai/total");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
function checkEntry(e, i, errors) {
  if (!isObj(e)) return errors.push(`repos[${i}] is not an object`);
  const x = e;
  if (typeof x.fullName !== "string" || !REPO.test(x.fullName)) errors.push(`repos[${i}].fullName is not owner/repo`);
  for (const f of ["stars", "ai", "total", "prAi", "prTotal"]) if (!isCount(x[f])) errors.push(`repos[${i}].${f} is not a count`);
  if (isCount(x.ai) && isCount(x.total) && x.ai > x.total) errors.push(`repos[${i}].ai is larger than total`);
  if (isCount(x.ai) && counts(x.byAgent, `repos[${i}].byAgent`, errors) !== x.ai) errors.push(`repos[${i}].byAgent does not add up to ai`);
  if (x.share !== null && (typeof x.share !== "number" || !Number.isFinite(x.share) || x.share < 0 || x.share > 1)) errors.push(`repos[${i}].share is not between 0 and 1`);
  if (x.top !== null && typeof x.top !== "string") errors.push(`repos[${i}].top is not an agent id`);
  if (typeof x.capped !== "boolean") errors.push(`repos[${i}].capped is not a boolean`);
  if (!isDate(x.measuredAt)) errors.push(`repos[${i}].measuredAt is not a date`);
  if (x.cohort !== void 0 && x.cohort !== "top" && x.cohort !== "tracked") errors.push(`repos[${i}].cohort is unknown`);
  if (x.likely !== void 0 && x.likely !== null) {
    const l = x.likely;
    const ok = isObj(l) && ["lo", "point", "hi"].every((k) => typeof l[k] === "number" && Number.isFinite(l[k]));
    const { lo, point, hi } = l ?? {};
    if (!ok || lo < 0 || hi > 1 || lo > point || point > hi) errors.push(`repos[${i}].likely is not a range lo \u2264 point \u2264 hi in 0..1`);
  }
}
function validateBoard(v) {
  const errors = [];
  if (!isObj(v)) return { ok: false, errors: ["not an object"] };
  const b = v;
  if (b.schema !== 1) errors.push("schema is not 1");
  if (!isDate(b.generatedAt)) errors.push("generatedAt is not a date");
  if (!isCount(b.days)) errors.push("days is not a count");
  if (!Array.isArray(b.repos)) errors.push("repos is not a list");
  else b.repos.forEach((e, i) => checkEntry(e, i, errors));
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, value: v };
}

// src/mcp/server.ts
var SITE = "https://maximilianfeix.github.io/howmuchai";
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var MODERN_VERSIONS = ["2026-07-28"];
var META_VERSION = "io.modelcontextprotocol/protocolVersion";
var META_CAPS = "io.modelcontextprotocol/clientCapabilities";
var META_SERVER = "io.modelcontextprotocol/serverInfo";
var ToolError = class extends Error {
};
var READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
var TOOLS = [
  {
    name: "measure_repo",
    title: "Measure AI-signed commits of a GitHub repo",
    description: "Share of a public GitHub repo's recent commits and pull requests that disclose an AI coding agent (co-author trailers, agent bot accounts, default PR footers, branch names), per agent, with evidence links. Also returns the experimental 'beyond signatures' range when the repo itself discloses enough agent use. Disclosed signatures are a lower bound: no signature does not mean human-written. Uses the stored daily measurement when the repo is tracked, else measures live (about 10 GitHub API requests).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo or a github.com URL" },
        live: { type: "boolean", description: "Measure now instead of using the stored daily measurement. Default false." },
        days: { type: "integer", minimum: 1, maximum: 365, description: `Window in days. Default ${DEFAULTS.days}; other values always measure live.` },
        evidence: { type: "integer", minimum: 0, maximum: 50, description: "How many matching commits/PRs to list. Default 5." }
      },
      required: ["repo"],
      additionalProperties: false
    },
    annotations: { title: "Measure repo", ...READ_ONLY }
  },
  {
    name: "leaderboard",
    title: "AI-signed share of the most-starred GitHub repos",
    description: "Rows of the howmuchai leaderboard: the 1,000 most-starred GitHub repos with recent pushes, measured daily. Filter by name or agent and sort by AI-signed share, stars, signed commits or the experimental estimate.",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ["share", "stars", "ai", "likely"], description: "Default share (repos with fewer than 10 commits last)." },
        agent: { type: "string", description: `Only repos with commits signed by this agent id: ${registry.agents.map((a) => a.id).join(", ")}` },
        query: { type: "string", description: "Substring of owner/repo." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
        tracked: { type: "boolean", description: "List the repos tracked on request instead of the top cohort." }
      },
      additionalProperties: false
    },
    annotations: { title: "Leaderboard", ...READ_ONLY }
  },
  {
    name: "check_commit",
    title: "Check a commit message for AI agent signatures",
    description: "Runs the howmuchai signature registry on one commit message (and optional author), offline. Shows which agent signatures match and whether they count (high confidence) or are only hints. Use it to test trailers or to explain why a commit was counted.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Full commit message, including trailers." },
        author_name: { type: "string" },
        author_email: { type: "string" },
        author_login: { type: "string", description: "GitHub login of the author." }
      },
      required: ["message"],
      additionalProperties: false
    },
    annotations: { title: "Check commit", ...READ_ONLY, openWorldHint: false }
  },
  {
    name: "list_signatures",
    title: "List the AI agent signatures howmuchai knows",
    description: "The signature registry: per agent, where each signal is looked for, its pattern and whether it counts or is only a hint.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", description: "Only this agent id." } },
      additionalProperties: false
    },
    annotations: { title: "List signatures", ...READ_ONLY, openWorldHint: false }
  }
];
var INSTRUCTIONS = "howmuchai counts what is disclosed: commits and pull requests with an AI agent signature. Report shares as a lower bound of AI use and never call a repo or commit human-written because it has no signature. The 'beyond signatures' range is experimental; quote it as a range with its caveat, never as a verdict on single commits.";
function str(args, k, required = false) {
  const v = args[k];
  if (v === void 0 || v === null) {
    if (required) throw new ToolError(`"${k}" is required`);
    return void 0;
  }
  if (typeof v !== "string") throw new ToolError(`"${k}" must be a string`);
  if (v.length > 65536) throw new ToolError(`"${k}" is too long`);
  return v;
}
function int(args, k, def, min, max) {
  const v = args[k];
  if (v === void 0 || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`"${k}" must be a whole number from ${min} to ${max}`);
  return v;
}
function bool(args, k) {
  const v = args[k];
  if (v === void 0 || v === null) return false;
  if (typeof v !== "boolean") throw new ToolError(`"${k}" must be true or false`);
  return v;
}
function onlyKnown(args, tool) {
  const known = new Set(Object.keys(tool.inputSchema.properties));
  const extra = Object.keys(args).find((k) => !known.has(k));
  if (extra) throw new ToolError(`Unknown argument "${extra.slice(0, 100)}"`);
}
var pc = (x) => `${Math.round(100 * x)}%`;
function summarize(r, evidence, source) {
  const c2 = r.commits, p = r.pulls, b = r.beyond;
  const agents = Object.entries(c2.byAgent).sort((a, z) => z[1] - a[1]).map(([id, n]) => ({ agent: id, name: agentName(id), commits: n, share: n / Math.max(1, c2.total) }));
  const page = `${SITE}/${pagePath(r.repo.fullName)}`;
  const structured = {
    repo: r.repo.fullName,
    stars: r.repo.stars,
    window: r.window,
    measuredAt: r.generatedAt,
    source,
    commits: { total: c2.total, aiSigned: c2.ai, share: r.share, hints: c2.hints, coverage: coverageLabel(c2, r, "commits"), capped: c2.capped },
    pullRequests: { total: p.total, aiSigned: p.ai, share: p.total ? p.ai / p.total : null, coverage: coverageLabel(p, r, "pull requests"), capped: p.capped },
    agents,
    beyondSignatures: b ? {
      experimental: true,
      likely: b.likely,
      noEstimateBecause: b.likely ? null : noEstimateReason(b.reason),
      commitsByAuthorsWhoDiscloseAgentUse: c2.total ? b.authors.commitsByAiAuthors / c2.total : null,
      agentSetupFiles: b.setup?.map((s) => s.path) ?? null
    } : null,
    evidence: [...c2.evidence, ...p.evidence].slice(0, evidence).map((e) => ({ agent: e.agentId, ref: e.ref, title: e.title, matched: e.matched, url: e.url })),
    page
  };
  const lines = [
    `${r.repo.fullName}: ${formatShare(c2.ai, c2.total)} of commits are AI-signed (${c2.ai} of ${c2.total}; ${coverageLabel(c2, r, "commits")}).`,
    `Pull requests: ${formatShare(p.ai, p.total)} (${p.ai} of ${p.total}).`,
    agents.length ? `Agents: ${agents.map((a) => `${a.name} ${formatShare(a.commits, c2.total)}`).join(", ")}.` : "No agent signatures found (this does not mean human-written)."
  ];
  if (b?.likely) lines.push(`Beyond signatures (experimental): likely ${formatRange(b.likely.lo, b.likely.hi)} AI-involved, best estimate ${pc(b.likely.point)}.`);
  else if (b) lines.push(`Beyond signatures: no estimate, because ${noEstimateReason(b.reason)}.`);
  for (const e of structured.evidence) lines.push(`- ${e.ref} ${agentName(e.agent)}: ${e.matched} ${e.url}`);
  lines.push(`Signatures are a lower bound of AI use. Measured ${r.generatedAt.slice(0, 10)} (${source}). ${page}`);
  return { text: lines.join("\n"), structured };
}
function createServer(deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const token = deps.token ?? null;
  const github = deps.github ?? ((signal) => new GitHubClient({ token, userAgent: `howmuchai-mcp/${VERSION}`, attempts: 3, maxWaitMs: 3e4, timeoutMs: 3e4, signal }));
  const SERVER_INFO = { name: "howmuchai", title: "howmuchai", version: VERSION, websiteUrl: SITE };
  const inflight = /* @__PURE__ */ new Map();
  const cls = createClassifier(registry);
  let board = null;
  let boardAt = 0;
  const redact = (s) => token ? s.split(token).join("***") : s;
  async function getJson(path) {
    const res = await doFetch(`${SITE}/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(2e4) });
    if (res.status === 404) return null;
    if (!res.ok) throw new ToolError(`The howmuchai site answered ${res.status} for ${path}`);
    return res.json();
  }
  async function loadBoard() {
    if (!board || Date.now() - boardAt > 10 * 6e4) {
      boardAt = Date.now();
      board = (async () => {
        const v = validateBoard(await getJson("data/leaderboard.json"));
        if (!v.ok) throw new ToolError("The leaderboard is not available right now");
        return v.value;
      })();
    }
    try {
      return await board;
    } catch (e) {
      board = null;
      throw e;
    }
  }
  async function measure(args, signal) {
    const repo = parseRepo(str(args, "repo", true));
    if (!repo) throw new ToolError("Not a GitHub repository. Use owner/repo or a github.com URL.");
    const live = bool(args, "live");
    const days = int(args, "days", DEFAULTS.days, 1, 365);
    const evidence = int(args, "evidence", 5, 0, 50);
    if (!live && days === DEFAULTS.days) {
      const stored = await getJson(reportPath(repo)).catch(() => null);
      const v = stored ? validateReport(stored) : null;
      if (v?.ok) return summarize(v.value, evidence, "stored");
    }
    try {
      return summarize(await analyzeRepo(repo, { client: github(signal), days }), evidence, "live");
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new ToolError(`Repository not found or private: ${repo}`);
      if (e instanceof GitHubError && (e.resetAt || e.secondary))
        throw new ToolError(`GitHub API rate limit reached${token ? "" : ". Set GITHUB_TOKEN in the server's environment for 5,000 requests per hour"}.`);
      throw new ToolError(`Could not measure ${repo}: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
  }
  async function leaderboard(args) {
    const sort = str(args, "sort") ?? "share";
    if (!["share", "stars", "ai", "likely"].includes(sort)) throw new ToolError('"sort" must be share, stars, ai or likely');
    const agent = str(args, "agent");
    if (agent && !registry.agents.some((a) => a.id === agent)) throw new ToolError(`Unknown agent "${agent.slice(0, 100)}". Known: ${registry.agents.map((a) => a.id).join(", ")}`);
    const query = str(args, "query")?.toLowerCase();
    const limit = int(args, "limit", 20, 1, 100);
    const tracked = bool(args, "tracked");
    const b = await loadBoard();
    const key = (e) => sort === "stars" ? e.stars : sort === "ai" ? e.ai : sort === "likely" ? e.likely?.point ?? -1 : e.total < 10 ? -1 : e.share ?? -1;
    const rows = b.repos.filter((e) => (e.cohort ?? "top") === "tracked" === tracked).filter((e) => (!query || e.fullName.toLowerCase().includes(query)) && (!agent || (e.byAgent[agent] ?? 0) > 0)).sort((a, z) => key(z) - key(a) || z.stars - a.stars);
    const shown = rows.slice(0, limit).map((e, i) => ({
      rank: i + 1,
      repo: e.fullName,
      stars: e.stars,
      aiSignedShare: e.share,
      aiSigned: e.ai,
      commits: e.total,
      topAgent: e.top,
      likely: e.likely ?? null,
      measuredAt: e.measuredAt
    }));
    const text = [
      `${rows.length} repos match; showing ${shown.length}, sorted by ${sort}. Board built ${b.generatedAt.slice(0, 16).replace("T", " ")} UTC, ${b.days}-day window.`,
      ...shown.map((r) => `${r.rank}. ${r.repo}: ${formatShare(r.aiSigned, r.commits)} AI-signed (${r.aiSigned}/${r.commits})${r.likely ? `, likely ${formatRange(r.likely.lo, r.likely.hi)} (experimental)` : ""}`),
      `Full list: ${SITE}/leaderboard/`
    ];
    return { text: text.join("\n"), structured: { generatedAt: b.generatedAt, days: b.days, matching: rows.length, rows: shown } };
  }
  function check(args) {
    const commit = {
      sha: "0000000",
      message: str(args, "message", true),
      date: (/* @__PURE__ */ new Date(0)).toISOString(),
      url: "",
      authorName: str(args, "author_name") ?? null,
      authorEmail: str(args, "author_email") ?? null,
      authorLogin: str(args, "author_login") ?? null,
      parents: 1
    };
    const ignored = cls.isIgnoredCommit(commit);
    const matches = ignored ? [] : cls.commit(commit);
    const counted = matches.some((m) => m.confidence === "high");
    const structured = {
      ignored,
      counted,
      agent: counted ? matches[0].agentId : null,
      matches: matches.map((m) => ({ agent: m.agentId, signal: m.signalId, kind: m.kind, confidence: m.confidence, matched: m.matched }))
    };
    const text = ignored ? "This author is a dependency or release bot; howmuchai leaves such commits out of all counts." : matches.length === 0 ? "No AI agent signature found. This does not mean the commit is human-written." : `${counted ? `Counts as AI-signed (${agentName(matches[0].agentId)}).` : "Only hints (medium confidence); not counted."}
${matches.map((m) => `- ${agentName(m.agentId)} \xB7 ${m.signalId} \xB7 ${m.confidence}: ${m.matched}`).join("\n")}`;
    return { text, structured };
  }
  function signatures(args) {
    const agent = str(args, "agent");
    const agents = registry.agents.filter((a) => !agent || a.id === agent);
    if (agent && agents.length === 0) throw new ToolError(`Unknown agent "${agent.slice(0, 100)}"`);
    const structured = {
      registryVersion: registry.version,
      agents: agents.map((a) => ({ id: a.id, name: a.name, signals: a.signals.map((s) => ({ id: s.id, kind: s.kind, pattern: s.pattern, counts: s.confidence === "high" })) }))
    };
    const text = structured.agents.map((a) => `${a.name} (${a.id}): ${a.signals.length ? a.signals.map((s) => `${s.kind}${s.counts ? "" : " (hint)"}`).join(", ") : "no known signature"}`).join("\n");
    return { text: `Registry v${registry.version}
${text}`, structured };
  }
  function toolResult(out, isError) {
    return { content: [{ type: "text", text: out.text }], ...out.structured !== void 0 ? { structuredContent: out.structured } : {}, isError };
  }
  async function callTool(name, args, signal) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    if (args !== void 0 && (typeof args !== "object" || args === null || Array.isArray(args))) return toolResult({ text: "Arguments must be an object" }, true);
    const a = args ?? {};
    try {
      onlyKnown(a, tool);
      const out = tool.name === "measure_repo" ? await measure(a, signal) : tool.name === "leaderboard" ? await leaderboard(a) : tool.name === "check_commit" ? check(a) : signatures(a);
      return toolResult(out, false);
    } catch (e) {
      if (e instanceof ToolError) return toolResult({ text: e.message }, true);
      return toolResult({ text: `Unexpected error: ${redact(e instanceof Error ? e.message : String(e))}` }, true);
    }
  }
  async function handle(msg) {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    const m = msg;
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    const params = typeof m.params === "object" && m.params !== null && !Array.isArray(m.params) ? m.params : {};
    if (typeof m.method !== "string") {
      if (hasId && ("result" in m || "error" in m)) return null;
      return { jsonrpc: "2.0", id: hasId ? m.id : null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (!hasId) {
      if (m.method === "notifications/cancelled" && (typeof params.requestId === "string" || typeof params.requestId === "number")) inflight.get(params.requestId)?.abort();
      return null;
    }
    const id = m.id;
    const fail = (code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...data !== void 0 ? { data } : {} } });
    const meta = typeof params._meta === "object" && params._meta !== null ? params._meta : {};
    const modern = META_VERSION in meta || m.method === "server/discover";
    if (modern && m.method !== "server/discover") {
      const v = meta[META_VERSION];
      if (typeof v !== "string") return fail(-32602, `Invalid params: _meta["${META_VERSION}"] must be a string`);
      if (!MODERN_VERSIONS.includes(v)) return fail(-32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], requested: v.slice(0, 50) });
      if (typeof meta[META_CAPS] !== "object" || meta[META_CAPS] === null) return fail(-32602, `Invalid params: _meta["${META_CAPS}"] is required`);
    }
    const ok = (result, cacheable = false) => ({
      jsonrpc: "2.0",
      id,
      result: modern ? { ...result, resultType: "complete", ...cacheable ? { ttlMs: 36e5, cacheScope: "public" } : {}, _meta: { [META_SERVER]: SERVER_INFO } } : result
    });
    switch (m.method) {
      case "server/discover":
        return ok({ supportedVersions: [...MODERN_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS }, true);
      case "initialize": {
        const asked = params.protocolVersion;
        const version = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS }, true);
      case "tools/call": {
        const ctrl = new AbortController();
        inflight.set(id, ctrl);
        try {
          const r = await callTool(params.name, params.arguments, ctrl.signal);
          if (ctrl.signal.aborted) return null;
          if (!r) return fail(-32602, `Unknown tool: ${String(params.name).slice(0, 100)}`);
          return ok(r);
        } finally {
          inflight.delete(id);
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method.slice(0, 100)}`);
    }
  }
  return { handle };
}
async function runStdio(deps = {}) {
  const server = createServer(deps);
  const write = (r) => {
    if (r) process.stdout.write(JSON.stringify(r) + "\n");
  };
  const MAX_LINE = 4 * 1024 * 1024;
  let buf = "";
  let skipping = false;
  const pending = /* @__PURE__ */ new Set();
  process.stdin.setEncoding("utf8");
  await new Promise((resolve) => {
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (skipping) {
          skipping = false;
          continue;
        }
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        const p = server.handle(msg).then(write).catch((e) => {
          process.stderr.write(`howmuchai mcp: ${e instanceof Error ? e.message : String(e)}
`);
        }).finally(() => pending.delete(p));
        pending.add(p);
      }
      if (buf.length > MAX_LINE) {
        buf = "";
        skipping = true;
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } });
      }
    });
    process.stdin.on("end", resolve);
  });
  await Promise.all(pending);
}

// src/cli/index.ts
var HELP = `howmuchai ${VERSION}
How much of a GitHub repo was built with AI? Counts commits and pull requests
that carry an AI coding-agent signature (a lower bound of disclosed AI use).

Usage
  npx howmuchai <owner/repo | github url> [options]
  npx howmuchai mcp        run as an MCP server on stdio (for Claude, Cursor, VS Code)

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
function section(title, sec, unit, r) {
  const lines = [`${c.bold(title)}  ${c.bold(pct(sec.ai, sec.total))} ${c.dim(`(${sec.ai} of ${sec.total})`)}`];
  lines.push(`  ${bar(sec)}`);
  const entries = Object.entries(sec.byAgent).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of entries) {
    lines.push(`  ${c.hex(agentColor(id), "\u25A0")} ${agentName(id).padEnd(16)} ${String(n).padStart(5)}  ${c.dim(pct(n, sec.total))}`);
  }
  if (sec.hints) {
    const by = Object.entries(sec.hintsByAgent).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${agentName(id)} ${n}`).join(", ");
    lines.push(c.dim(`  + ${sec.hints} with only a hint, not counted (${by})`));
  }
  lines.push(c.dim(`  ${coverageLabel(sec, r, unit)}`));
  return lines;
}
function render(r, evidence) {
  const lines = [
    "",
    `${c.bold(clean(r.repo.fullName))}  ${c.dim(`\u2605 ${r.repo.stars.toLocaleString("en-US")} \xB7 measured ${r.window.until.slice(0, 10)}`)}`,
    "",
    ...section("AI-signed commits", r.commits, "commits", r),
    "",
    ...section("AI-signed pull requests", r.pulls, "pull requests", r),
    ""
  ];
  const b = r.beyond;
  if (b && r.commits.total > 0) {
    const pc2 = (x) => `${Math.round(100 * x)}%`;
    lines.push(`${c.bold("Beyond signatures")} ${c.dim("(experimental)")}`);
    if (b.estimate && b.likely) {
      lines.push(`  likely ${c.bold(`${pc2(b.likely.lo)}\u2013${pc2(b.likely.hi)}`)} AI-involved, best estimate ${pc2(b.likely.point)}`);
      lines.push(c.dim(`  style estimate of ${b.estimate.judged ?? r.commits.total - r.commits.ai - b.estimate.tooShort} undisclosed commits vs ${b.estimate.humanReference === "own-history" ? "this repo before July 2022" : "typical human commits"}; ${b.estimate.tooShort} too short to judge${b.estimate.bots ? `, ${b.estimate.bots} by bots left out` : ""}`));
    } else {
      lines.push(c.dim(`  no estimate: ${noEstimateReason(b.reason)}`));
    }
    if (b.authors.aiAuthors) lines.push(`  ${pc2(b.authors.commitsByAiAuthors / r.commits.total)} of commits by ${b.authors.aiAuthors}/${b.authors.authors} authors who disclose agent use here`);
    if (b.setup) lines.push(`  agent setup files: ${b.setup.length ? b.setup.map((s) => s.path).join(", ") : "none"}`);
    lines.push("");
  }
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
  if (args[0] === "mcp") {
    if (args.length > 1) {
      process.stderr.write(`"howmuchai mcp" takes no options; set GITHUB_TOKEN in its environment.
`);
      process.exit(2);
    }
    await runStdio({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null });
    return;
  }
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const fail = (msg) => {
    process.stderr.write(`${msg}
Run "howmuchai --help" for usage.
`);
    process.exit(2);
  };
  const intFlag = (name, def, min, maxV) => {
    const i = args.indexOf(name);
    if (i === -1) return def;
    const v = args[i + 1];
    if (v === void 0 || v.startsWith("-")) fail(`${name} needs a value`);
    if (!/^\d+$/.test(v)) fail(`${name} must be a whole number, got "${clean(v)}"`);
    const n = Number(v);
    if (n < min || n > maxV) fail(`${name} must be between ${min} and ${maxV}, got ${n}`);
    args.splice(i, 2);
    return n;
  };
  const days = intFlag("--days", DEFAULTS.days, 1, 3650);
  const maxCommits = intFlag("--max", DEFAULTS.maxCommits, 1, 1e4);
  const json = args.includes("--json");
  const evidence = args.includes("--evidence");
  const known = /* @__PURE__ */ new Set(["--json", "--evidence"]);
  const unknown = args.find((a) => a.startsWith("-") && !known.has(a));
  if (unknown) fail(`Unknown option ${clean(unknown)}`);
  const targets = args.filter((a) => !a.startsWith("-"));
  if (targets.length !== 1) fail(targets.length === 0 ? "Name a repository, e.g. vercel/next.js" : "Name exactly one repository");
  const repo = parseRepo(targets[0]);
  if (!repo) fail(`Not a GitHub repository: ${clean(targets[0])}`);
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
      let msg = clean(e instanceof Error ? e.message : String(e));
      if (token) msg = msg.split(token).join("***");
      process.stderr.write(`${msg}
`);
    }
    process.exit(1);
  }
}
main();
