import type { CommitInput, PullInput } from "./types";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Unix seconds when the rate limit resets, if the error was a rate limit. */
    readonly resetAt: number | null = null,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface ClientOptions {
  token?: string | null;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Only sent outside browsers. */
  userAgent?: string;
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
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (!isBrowser) headers["User-Agent"] = this.opts.userAgent ?? "howmuchai";
    const res = await this.doFetch(`${this.base}${path}`, { headers });
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
      const rateLimited = (res.status === 403 || res.status === 429) && (remaining === 0 || /rate limit/i.test(msg));
      throw new GitHubError(msg, res.status, rateLimited ? reset || null : null);
    }
    return (await res.json()) as T;
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
      const batch = await this.get<RawCommit[]>(`/repos/${fullName}/commits?${range}&per_page=${perPage}&page=${page}`);
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
