import type { CommitInput, PullInput } from "./types";

export class GitHubError extends Error {
  /** True for GitHub's secondary (abuse) rate limits, which clear after a short wait. */
  readonly secondary: boolean;
  /** Milliseconds GitHub asked to wait (Retry-After), if any. */
  readonly retryAfter: number | null;
  constructor(
    message: string,
    readonly status: number,
    /** Unix seconds when the primary rate limit resets, if the error was that limit. */
    readonly resetAt: number | null = null,
    extra: { secondary?: boolean; retryAfter?: number | null } = {},
  ) {
    super(message);
    this.name = "GitHubError";
    this.secondary = extra.secondary ?? false;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

/** The caller aborted the request. Never retried. */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** The request never got an HTTP answer (DNS, connection reset, timeout). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Parses Retry-After (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/**
 * How long to wait before retrying, or null if the error is not worth retrying.
 * Retried: network errors, 5xx, secondary rate limits. Not retried: 4xx like 401/404/409/422/451 and the
 * primary rate limit (its reset is usually far away; callers stop and report it instead).
 */
export function retryDelay(e: unknown, attempt: number, _nowMs: number, random: () => number): number | null {
  const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + random() / 2);
  if (e instanceof NetworkError) return backoff;
  if (!(e instanceof GitHubError)) return null;
  if (e.resetAt) return null;
  if (e.retryAfter !== null && (e.secondary || e.status >= 500 || e.status === 429)) return e.retryAfter;
  if (e.secondary) return Math.max(backoff, 60_000 * (0.5 + random() / 2));
  if (e.status >= 500) return backoff;
  return null;
}

export interface ClientOptions {
  token?: string | null;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Only sent outside browsers. */
  userAgent?: string;
  /** Attempts per request for retryable failures (network, 5xx, secondary rate limits). Default 4. */
  attempts?: number;
  /** Longest single wait before a retry; a longer Retry-After fails fast instead. Default 60 s. */
  maxWaitMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Aborts all requests of this client, e.g. when the user navigates away. */
  signal?: AbortSignal;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RepoInfo {
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  defaultBranch: string;
  language: string | null;
  archived: boolean;
  fork: boolean;
}

export interface RateInfo {
  limit: number;
  remaining: number;
  reset: number;
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export class GitHubClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  lastRate: RateInfo | null = null;
  requests = 0;

  constructor(private readonly opts: ClientOptions = {}) {
    this.base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.doFetch = opts.fetch ?? fetch.bind(globalThis);
  }

  async get<T>(path: string): Promise<T> {
    const attempts = this.opts.attempts ?? 4;
    const maxWait = this.opts.maxWaitMs ?? 60_000;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const random = this.opts.random ?? Math.random;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let wait: number | null = null;
      try {
        return await this.once<T>(path);
      } catch (e) {
        lastError = e;
        wait = retryDelay(e, attempt, now(), random);
      }
      if (wait === null || attempt === attempts || wait > maxWait) break;
      await sleep(wait);
    }
    throw lastError;
  }

  private async once<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (!isBrowser) headers["User-Agent"] = this.opts.userAgent ?? "howmuchai";
    if (this.opts.signal?.aborted) throw new AbortedError();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000) : null;
    const onAbort = () => ctrl?.abort();
    this.opts.signal?.addEventListener("abort", onAbort);
    try {
      let res: Response;
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
      // Search has its own small per-minute quota; only the core quota decides how much work is left.
      const resource = res.headers.get("x-ratelimit-resource") ?? "core";
      if (resource === "core" && res.headers.has("x-ratelimit-limit")) this.lastRate = { limit, remaining, reset };
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          /* body was not JSON */
        }
        const primary = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
        const secondary = (res.status === 403 || res.status === 429) && !primary && (/secondary rate limit|abuse/i.test(msg) || res.headers.has("retry-after") || res.status === 429);
        throw new GitHubError(msg, res.status, primary ? reset || null : null, {
          secondary,
          retryAfter: parseRetryAfter(res.headers.get("retry-after"), Date.now()),
        });
      }
      // The timeout and abort stay armed while the body is read; a stalled or broken body is a network error.
      try {
        return (await res.json()) as T;
      } catch (e) {
        if (this.opts.signal?.aborted) throw new AbortedError();
        throw new NetworkError(`reading the response failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async repo(fullName: string): Promise<RepoInfo> {
    const r = await this.get<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      default_branch: string;
      language: string | null;
      archived: boolean;
      fork: boolean;
    }>(`/repos/${fullName}`);
    return {
      fullName: r.full_name,
      url: r.html_url,
      description: r.description,
      stars: r.stargazers_count,
      defaultBranch: r.default_branch,
      language: r.language,
      archived: r.archived,
      fork: r.fork,
    };
  }

  /**
   * Commits on the default branch between `since` and `until`, newest first, at most `max`.
   * `capped` is true exactly when more commits exist in the window than were returned.
   */
  async commits(fullName: string, since: string, max: number, until?: string): Promise<{ items: CommitInput[]; capped: boolean }> {
    const items: CommitInput[] = [];
    const perPage = 100;
    const range = `since=${encodeURIComponent(since)}${until ? `&until=${encodeURIComponent(until)}` : ""}`;
    for (let page = 1; ; page++) {
      let batch: RawCommit[];
      try {
        batch = await this.get<RawCommit[]>(`/repos/${fullName}/commits?${range}&per_page=${perPage}&page=${page}`);
      } catch (e) {
        // An empty repository answers 409 "Git Repository is empty."
        if (e instanceof GitHubError && e.status === 409 && page === 1 && /empty/i.test(e.message)) return { items: [], capped: false };
        throw e;
      }
      for (const c of batch) items.push(toCommit(c));
      if (items.length > max) return { items: items.slice(0, max), capped: true };
      if (batch.length < perPage) return { items, capped: false };
      if (items.length === max) {
        // Exactly at the cap on a page boundary: look one item further to know whether anything is left.
        const next = await this.get<RawCommit[]>(`/repos/${fullName}/commits?${range}&per_page=1&page=${max + 1}`);
        return { items, capped: next.length > 0 };
      }
    }
  }

  /**
   * Pull requests opened between `since` and `until`, newest first, at most `max`.
   * `capped` is true exactly when more pull requests were opened in the window than were returned.
   */
  async pulls(fullName: string, since: string, max: number, until?: string): Promise<{ items: PullInput[]; capped: boolean }> {
    const items: PullInput[] = [];
    const perPage = 100;
    const sinceMs = Date.parse(since);
    const untilMs = until ? Date.parse(until) : Infinity;
    for (let page = 1; ; page++) {
      let batch: RawPull[];
      try {
        batch = await this.get<RawPull[]>(
          `/repos/${fullName}/pulls?state=all&sort=created&direction=desc&per_page=${perPage}&page=${page}`,
        );
      } catch (e) {
        // Repos with pull requests turned off (torvalds/linux) answer 404 here.
        if (e instanceof GitHubError && e.status === 404 && page === 1) return { items: [], capped: false };
        throw e;
      }
      for (const p of batch) {
        const t = Date.parse(p.created_at);
        if (t > untilMs) continue; // opened after the measurement started
        if (t < sinceMs) return { items: items.slice(0, max), capped: items.length > max };
        items.push(toPull(p));
        if (items.length > max) return { items: items.slice(0, max), capped: true };
      }
      if (batch.length < perPage) return { items, capped: false };
    }
  }
}

interface RawUser {
  login: string;
}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer: { name?: string; email?: string; date?: string } | null;
  };
  author: RawUser | null;
  committer: RawUser | null;
  parents: unknown[];
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  user: RawUser | null;
  head: { ref: string };
  created_at: string;
  merged_at: string | null;
  html_url: string;
}

export function toCommit(c: RawCommit): CommitInput {
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
    parents: c.parents?.length ?? 1,
  };
}

export function toPull(p: RawPull): PullInput {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    authorLogin: p.user?.login ?? null,
    branch: p.head?.ref ?? "",
    createdAt: p.created_at,
    mergedAt: p.merged_at,
    url: p.html_url,
  };
}
