/**
 * Model Context Protocol server for howmuchai, over stdio (newline-delimited JSON-RPC 2.0).
 *
 *   npx -y github:maximilianfeix/howmuchai mcp
 *
 * Hand-rolled on purpose: four read-only tools need initialize, tools/list, tools/call and ping, nothing else,
 * and the CLI bundle stays free of dependencies. Everything printed on stdout is protocol; logs go to stderr.
 */
import { analyzeRepo, DEFAULTS, parseRepo, VERSION } from "../core/analyze";
import { createClassifier } from "../core/classify";
import { pagePath, reportPath, type Board, type BoardEntry } from "../core/dataset";
import { formatRange, formatShare, noEstimateReason } from "../core/format";
import { GitHubClient, GitHubError } from "../core/github";
import { agentName, registry } from "../core/registry";
import { coverageLabel } from "../core/render";
import type { Report } from "../core/types";
import { validateBoard, validateReport } from "../core/validate";

export const SITE = "https://maximilianfeix.github.io/howmuchai";
/** Newest first. The answer to initialize is the client's version when listed here, else the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

interface Response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerDeps {
  /** fetch for the published site data (stored reports, leaderboard). */
  fetch?: typeof fetch;
  /** GitHub client for live measurements. */
  github?: () => GitHubClient;
  token?: string | null;
}

/** A tool failure the model should see (isError result), as opposed to a protocol error. */
class ToolError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const TOOLS = [
  {
    name: "measure_repo",
    title: "Measure AI-signed commits of a GitHub repo",
    description:
      "Share of a public GitHub repo's recent commits and pull requests that disclose an AI coding agent (co-author trailers, agent bot accounts, default PR footers, branch names), per agent, with evidence links. Also returns the experimental 'beyond signatures' range when the repo itself discloses enough agent use. Disclosed signatures are a lower bound: no signature does not mean human-written. Uses the stored daily measurement when the repo is tracked, else measures live (about 10 GitHub API requests).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo or a github.com URL" },
        live: { type: "boolean", description: "Measure now instead of using the stored daily measurement. Default false." },
        days: { type: "integer", minimum: 1, maximum: 365, description: `Window in days. Default ${DEFAULTS.days}; other values always measure live.` },
        evidence: { type: "integer", minimum: 0, maximum: 50, description: "How many matching commits/PRs to list. Default 5." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "Measure repo", ...READ_ONLY },
  },
  {
    name: "leaderboard",
    title: "AI-signed share of the most-starred GitHub repos",
    description:
      "Rows of the howmuchai leaderboard: the 1,000 most-starred GitHub repos with recent pushes, measured daily. Filter by name or agent and sort by AI-signed share, stars, signed commits or the experimental estimate.",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ["share", "stars", "ai", "likely"], description: "Default share (repos with fewer than 10 commits last)." },
        agent: { type: "string", description: `Only repos with commits signed by this agent id: ${registry.agents.map((a) => a.id).join(", ")}` },
        query: { type: "string", description: "Substring of owner/repo." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
        tracked: { type: "boolean", description: "List the repos tracked on request instead of the top cohort." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Leaderboard", ...READ_ONLY },
  },
  {
    name: "check_commit",
    title: "Check a commit message for AI agent signatures",
    description:
      "Runs the howmuchai signature registry on one commit message (and optional author), offline. Shows which agent signatures match and whether they count (high confidence) or are only hints. Use it to test trailers or to explain why a commit was counted.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Full commit message, including trailers." },
        author_name: { type: "string" },
        author_email: { type: "string" },
        author_login: { type: "string", description: "GitHub login of the author." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { title: "Check commit", ...READ_ONLY, openWorldHint: false },
  },
  {
    name: "list_signatures",
    title: "List the AI agent signatures howmuchai knows",
    description: "The signature registry: per agent, where each signal is looked for, its pattern and whether it counts or is only a hint.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", description: "Only this agent id." } },
      additionalProperties: false,
    },
    annotations: { title: "List signatures", ...READ_ONLY, openWorldHint: false },
  },
] as const;

type Tool = (typeof TOOLS)[number];

const INSTRUCTIONS =
  "howmuchai counts what is disclosed: commits and pull requests with an AI agent signature. Report shares as a lower bound of AI use and never call a repo or commit human-written because it has no signature. The 'beyond signatures' range is experimental; quote it as a range with its caveat, never as a verdict on single commits.";

// ---------- argument checks ----------

function str(args: Record<string, unknown>, k: string, required = false): string | undefined {
  const v = args[k];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`"${k}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${k}" must be a string`);
  if (v.length > 65_536) throw new ToolError(`"${k}" is too long`);
  return v;
}
function int(args: Record<string, unknown>, k: string, def: number, min: number, max: number): number {
  const v = args[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`"${k}" must be a whole number from ${min} to ${max}`);
  return v;
}
function bool(args: Record<string, unknown>, k: string): boolean {
  const v = args[k];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new ToolError(`"${k}" must be true or false`);
  return v;
}
function onlyKnown(args: Record<string, unknown>, tool: Tool) {
  const known = new Set(Object.keys(tool.inputSchema.properties));
  const extra = Object.keys(args).find((k) => !known.has(k));
  if (extra) throw new ToolError(`Unknown argument "${extra.slice(0, 100)}"`);
}

// ---------- tools ----------

const pc = (x: number) => `${Math.round(100 * x)}%`;

/** A compact, model-friendly summary of a report. */
export function summarize(r: Report, evidence: number, source: "stored" | "live") {
  const c = r.commits, p = r.pulls, b = r.beyond;
  const agents = Object.entries(c.byAgent)
    .sort((a, z) => z[1] - a[1])
    .map(([id, n]) => ({ agent: id, name: agentName(id), commits: n, share: n / Math.max(1, c.total) }));
  const page = `${SITE}/${pagePath(r.repo.fullName)}`;
  const structured = {
    repo: r.repo.fullName,
    stars: r.repo.stars,
    window: r.window,
    measuredAt: r.generatedAt,
    source,
    commits: { total: c.total, aiSigned: c.ai, share: r.share, hints: c.hints, coverage: coverageLabel(c, r, "commits"), capped: c.capped },
    pullRequests: { total: p.total, aiSigned: p.ai, share: p.total ? p.ai / p.total : null, coverage: coverageLabel(p, r, "pull requests"), capped: p.capped },
    agents,
    beyondSignatures: b
      ? {
          experimental: true,
          likely: b.likely,
          noEstimateBecause: b.likely ? null : noEstimateReason(b.reason),
          commitsByAuthorsWhoDiscloseAgentUse: c.total ? b.authors.commitsByAiAuthors / c.total : null,
          agentSetupFiles: b.setup?.map((s) => s.path) ?? null,
        }
      : null,
    evidence: [...c.evidence, ...p.evidence].slice(0, evidence).map((e) => ({ agent: e.agentId, ref: e.ref, title: e.title, matched: e.matched, url: e.url })),
    page,
  };
  const lines = [
    `${r.repo.fullName}: ${formatShare(c.ai, c.total)} of commits are AI-signed (${c.ai} of ${c.total}; ${coverageLabel(c, r, "commits")}).`,
    `Pull requests: ${formatShare(p.ai, p.total)} (${p.ai} of ${p.total}).`,
    agents.length ? `Agents: ${agents.map((a) => `${a.name} ${formatShare(a.commits, c.total)}`).join(", ")}.` : "No agent signatures found (this does not mean human-written).",
  ];
  if (b?.likely) lines.push(`Beyond signatures (experimental): likely ${formatRange(b.likely.lo, b.likely.hi)} AI-involved, best estimate ${pc(b.likely.point)}.`);
  else if (b) lines.push(`Beyond signatures: no estimate, because ${noEstimateReason(b.reason)}.`);
  for (const e of structured.evidence) lines.push(`- ${e.ref} ${agentName(e.agent)}: ${e.matched} ${e.url}`);
  lines.push(`Signatures are a lower bound of AI use. Measured ${r.generatedAt.slice(0, 10)} (${source}). ${page}`);
  return { text: lines.join("\n"), structured };
}

export function createServer(deps: ServerDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const token = deps.token ?? null;
  const github = deps.github ?? (() => new GitHubClient({ token, userAgent: `howmuchai-mcp/${VERSION}`, attempts: 3, maxWaitMs: 30_000, timeoutMs: 30_000 }));
  const cls = createClassifier(registry);
  let board: Promise<Board> | null = null;
  let boardAt = 0;
  const redact = (s: string) => (token ? s.split(token).join("***") : s);

  async function getJson(path: string): Promise<unknown | null> {
    const res = await doFetch(`${SITE}/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new ToolError(`The howmuchai site answered ${res.status} for ${path}`);
    return res.json();
  }

  async function loadBoard(): Promise<Board> {
    // The board changes hourly; keep it for ten minutes.
    if (!board || Date.now() - boardAt > 10 * 60_000) {
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
      board = null; // retry next time
      throw e;
    }
  }

  async function measure(args: Record<string, unknown>) {
    const repo = parseRepo(str(args, "repo", true)!);
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
      return summarize(await analyzeRepo(repo, { client: github(), days }), evidence, "live");
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new ToolError(`Repository not found or private: ${repo}`);
      if (e instanceof GitHubError && (e.resetAt || e.secondary))
        throw new ToolError(`GitHub API rate limit reached${token ? "" : ". Set GITHUB_TOKEN in the server's environment for 5,000 requests per hour"}.`);
      throw new ToolError(`Could not measure ${repo}: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
  }

  async function leaderboard(args: Record<string, unknown>) {
    const sort = str(args, "sort") ?? "share";
    if (!["share", "stars", "ai", "likely"].includes(sort)) throw new ToolError('"sort" must be share, stars, ai or likely');
    const agent = str(args, "agent");
    if (agent && !registry.agents.some((a) => a.id === agent)) throw new ToolError(`Unknown agent "${agent.slice(0, 100)}". Known: ${registry.agents.map((a) => a.id).join(", ")}`);
    const query = str(args, "query")?.toLowerCase();
    const limit = int(args, "limit", 20, 1, 100);
    const tracked = bool(args, "tracked");
    const b = await loadBoard();
    const key = (e: BoardEntry) => (sort === "stars" ? e.stars : sort === "ai" ? e.ai : sort === "likely" ? (e.likely?.point ?? -1) : e.total < 10 ? -1 : (e.share ?? -1));
    const rows = b.repos
      .filter((e) => ((e.cohort ?? "top") === "tracked") === tracked)
      .filter((e) => (!query || e.fullName.toLowerCase().includes(query)) && (!agent || (e.byAgent[agent] ?? 0) > 0))
      .sort((a, z) => key(z) - key(a) || z.stars - a.stars);
    const shown = rows.slice(0, limit).map((e, i) => ({
      rank: i + 1,
      repo: e.fullName,
      stars: e.stars,
      aiSignedShare: e.share,
      aiSigned: e.ai,
      commits: e.total,
      topAgent: e.top,
      likely: e.likely ?? null,
      measuredAt: e.measuredAt,
    }));
    const text = [
      `${rows.length} repos match; showing ${shown.length}, sorted by ${sort}. Board built ${b.generatedAt.slice(0, 16).replace("T", " ")} UTC, ${b.days}-day window.`,
      ...shown.map((r) => `${r.rank}. ${r.repo}: ${formatShare(r.aiSigned, r.commits)} AI-signed (${r.aiSigned}/${r.commits})${r.likely ? `, likely ${formatRange(r.likely.lo, r.likely.hi)} (experimental)` : ""}`),
      `Full list: ${SITE}/leaderboard/`,
    ];
    return { text: text.join("\n"), structured: { generatedAt: b.generatedAt, days: b.days, matching: rows.length, rows: shown } };
  }

  function check(args: Record<string, unknown>) {
    const commit = {
      sha: "0000000",
      message: str(args, "message", true)!,
      date: new Date(0).toISOString(),
      url: "",
      authorName: str(args, "author_name") ?? null,
      authorEmail: str(args, "author_email") ?? null,
      authorLogin: str(args, "author_login") ?? null,
      parents: 1,
    };
    const ignored = cls.isIgnoredCommit(commit);
    const matches = ignored ? [] : cls.commit(commit);
    const counted = matches.some((m) => m.confidence === "high");
    const structured = {
      ignored,
      counted,
      agent: counted ? matches[0]!.agentId : null,
      matches: matches.map((m) => ({ agent: m.agentId, signal: m.signalId, kind: m.kind, confidence: m.confidence, matched: m.matched })),
    };
    const text = ignored
      ? "This author is a dependency or release bot; howmuchai leaves such commits out of all counts."
      : matches.length === 0
        ? "No AI agent signature found. This does not mean the commit is human-written."
        : `${counted ? `Counts as AI-signed (${agentName(matches[0]!.agentId)}).` : "Only hints (medium confidence); not counted."}\n${matches.map((m) => `- ${agentName(m.agentId)} · ${m.signalId} · ${m.confidence}: ${m.matched}`).join("\n")}`;
    return { text, structured };
  }

  function signatures(args: Record<string, unknown>) {
    const agent = str(args, "agent");
    const agents = registry.agents.filter((a) => !agent || a.id === agent);
    if (agent && agents.length === 0) throw new ToolError(`Unknown agent "${agent.slice(0, 100)}"`);
    const structured = {
      registryVersion: registry.version,
      agents: agents.map((a) => ({ id: a.id, name: a.name, signals: a.signals.map((s) => ({ id: s.id, kind: s.kind, pattern: s.pattern, counts: s.confidence === "high" })) })),
    };
    const text = structured.agents
      .map((a) => `${a.name} (${a.id}): ${a.signals.length ? a.signals.map((s) => `${s.kind}${s.counts ? "" : " (hint)"}`).join(", ") : "no known signature"}`)
      .join("\n");
    return { text: `Registry v${registry.version}\n${text}`, structured };
  }

  function toolResult(out: { text: string; structured?: unknown }, isError: boolean) {
    return { content: [{ type: "text", text: out.text }], ...(out.structured !== undefined ? { structuredContent: out.structured } : {}), isError };
  }

  async function callTool(name: unknown, args: unknown) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return toolResult({ text: "Arguments must be an object" }, true);
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      onlyKnown(a, tool);
      const out = tool.name === "measure_repo" ? await measure(a) : tool.name === "leaderboard" ? await leaderboard(a) : tool.name === "check_commit" ? check(a) : signatures(a);
      return toolResult(out, false);
    } catch (e) {
      if (e instanceof ToolError) return toolResult({ text: e.message }, true);
      return toolResult({ text: `Unexpected error: ${redact(e instanceof Error ? e.message : String(e))}` }, true);
    }
  }

  /** Handles one message. Returns the response, or null for notifications and for responses sent to us. */
  async function handle(msg: unknown): Promise<Response | null> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    if (typeof m.method !== "string") {
      if (hasId && ("result" in m || "error" in m)) return null;
      return { jsonrpc: "2.0", id: hasId ? (m.id as string | number) : null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (!hasId) return null; // notification: initialized, cancelled, ...
    const id = m.id as string | number;
    const ok = (result: unknown): Response => ({ jsonrpc: "2.0", id, result });
    const params = (typeof m.params === "object" && m.params !== null && !Array.isArray(m.params) ? m.params : {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const version = typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "howmuchai", title: "howmuchai", version: VERSION, websiteUrl: SITE },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const r = await callTool(params.name, params.arguments);
        if (!r) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name).slice(0, 100)}` } };
        return ok(r);
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${m.method.slice(0, 100)}` } };
    }
  }

  return { handle };
}

/** Runs the server on stdin/stdout until stdin closes. */
export async function runStdio(deps: ServerDeps = {}): Promise<void> {
  const server = createServer(deps);
  const write = (r: Response | null) => {
    if (r) process.stdout.write(JSON.stringify(r) + "\n");
  };
  const MAX_LINE = 4 * 1024 * 1024;
  let buf = "";
  let skipping = false; // inside an oversized line, up to its newline
  const pending = new Set<Promise<void>>();
  process.stdin.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (skipping) {
          skipping = false;
          continue;
        }
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        // Requests run concurrently; each answers when done, matched by id.
        const p: Promise<void> = server
          .handle(msg)
          .then(write)
          .catch((e) => {
            process.stderr.write(`howmuchai mcp: ${e instanceof Error ? e.message : String(e)}\n`);
          })
          .finally(() => pending.delete(p));
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
