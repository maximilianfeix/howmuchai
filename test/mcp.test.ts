import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReport, type RepoData } from "../src/core/analyze";
import { buildBoard, toEntry } from "../src/core/dataset";
import { createServer, PROTOCOL_VERSIONS, SITE, TOOLS } from "../src/mcp/server";

const repoData = (signed: number, plain: number): RepoData => ({
  repo: { fullName: "o/r", url: "https://github.com/o/r", description: null, stars: 5, defaultBranch: "main", language: null, archived: false, fork: false },
  commits: {
    items: [
      ...Array.from({ length: signed }, (_, i) => ({ sha: `s${i}`, message: `Fix ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/s${i}`, parents: 1 })),
      ...Array.from({ length: plain }, (_, i) => ({ sha: `p${i}`, message: `Tweak ${i}`, date: "2026-10-10T00:00:00Z", url: `https://github.com/o/r/commit/p${i}`, parents: 1 })),
    ],
    capped: false,
  },
  pulls: { items: [], capped: false },
  baseline: [],
  setup: [],
  since: "2026-08-04T00:00:00Z",
  until: "2026-11-02T00:00:00Z",
  days: 90,
});

function fakeFetch(files: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const path = url.replace(`${SITE}/`, "");
    if (!(path in files)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(files[path]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("MCP server", () => {
  it("negotiates the protocol version", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    const r1 = (await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }))!;
    expect((r1.result as any).protocolVersion).toBe("2025-06-18");
    expect((r1.result as any).capabilities.tools).toBeDefined();
    const r2 = (await s.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }))!;
    expect((r2.result as any).protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("ignores notifications and responses, answers ping, rejects unknown methods and tools", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await s.handle({ jsonrpc: "2.0", id: 9, result: {} })).toBeNull();
    expect((await s.handle({ jsonrpc: "2.0", id: 1, method: "ping" }))!.result).toEqual({});
    expect((await s.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" }))!.error!.code).toBe(-32601);
    expect((await s.handle(call("nope", {})))!.error!.code).toBe(-32602);
    expect((await s.handle("garbage"))!.error!.code).toBe(-32600);
  });

  it("lists read-only tools with schemas", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!;
    const tools = (r.result as any).tools as typeof TOOLS;
    expect(tools.map((t) => t.name)).toEqual(["measure_repo", "leaderboard", "check_commit", "list_signatures"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  it("uses the stored report and never calls GitHub for it", async () => {
    const report = buildReport(repoData(3, 7));
    const { f, calls } = fakeFetch({ "data/repos/o/r.json": report });
    const s = createServer({ fetch: f, github: () => { throw new Error("must not measure live"); } });
    const r = (await s.handle(call("measure_repo", { repo: "https://github.com/O/R" })))!.result as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent.source).toBe("stored");
    expect(r.structuredContent.commits.aiSigned).toBe(3);
    expect(r.content[0].text).toContain("30% of commits are AI-signed");
    expect(r.content[0].text).toContain("lower bound");
    expect(calls).toEqual([`${SITE}/data/repos/o/r.json`]);
  });

  it("reports tool errors as results, not protocol errors", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    for (const args of [{}, { repo: "not a repo" }, { repo: "o/r", days: 0 }, { repo: "o/r", extra: 1 }, { repo: 5 }]) {
      const r = (await s.handle(call("measure_repo", args)))!;
      expect(r.error).toBeUndefined();
      expect((r.result as any).isError).toBe(true);
    }
    expect(((await s.handle(call("measure_repo", "x")))!.result as any).isError).toBe(true);
  });

  it("checks a commit message offline", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    const hit = ((await s.handle(call("check_commit", { message: "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>" })))!.result as any).structuredContent;
    expect(hit).toMatchObject({ counted: true, agent: "claude-code", ignored: false });
    const miss = ((await s.handle(call("check_commit", { message: "Fix typo" })))!.result as any);
    expect(miss.structuredContent.counted).toBe(false);
    expect(miss.content[0].text).toContain("does not mean");
    const bot = ((await s.handle(call("check_commit", { message: "Bump x", author_login: "dependabot[bot]" })))!.result as any).structuredContent;
    expect(bot.ignored).toBe(true);
  });

  it("filters and sorts the leaderboard and rejects unknown agents", async () => {
    const a = toEntry(buildReport(repoData(8, 2)));
    const b = toEntry({ ...buildReport(repoData(1, 19)), repo: { ...buildReport(repoData(1, 19)).repo, fullName: "x/y", stars: 99 } });
    const board = buildBoard([a, b], ["o/r", "x/y"], [], "2026-11-01T00:00:00Z", 90, new Date("2026-11-02T00:00:00Z"));
    const s = createServer({ fetch: fakeFetch({ "data/leaderboard.json": board }).f });
    const r = ((await s.handle(call("leaderboard", { limit: 5 })))!.result as any).structuredContent;
    expect(r.rows.map((x: any) => x.repo)).toEqual(["o/r", "x/y"]);
    const st = ((await s.handle(call("leaderboard", { sort: "stars", query: "x/" })))!.result as any).structuredContent;
    expect(st.rows.map((x: any) => x.repo)).toEqual(["x/y"]);
    expect(((await s.handle(call("leaderboard", { agent: "nobody" })))!.result as any).isError).toBe(true);
  });

  it("lists signatures for one agent", async () => {
    const s = createServer({ fetch: fakeFetch({}).f });
    const r = ((await s.handle(call("list_signatures", { agent: "claude-code" })))!.result as any).structuredContent;
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].signals.length).toBeGreaterThan(3);
  });

  it("never leaks the token in errors", async () => {
    const token = "ghp_secret123456";
    const s = createServer({ fetch: fakeFetch({}).f, token, github: () => { throw new Error(`boom ${token}`); } });
    const r = ((await s.handle(call("measure_repo", { repo: "o/r", live: true })))!.result as any);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain(token);
  });
});

describe.skipIf(!existsSync("dist/cli.mjs"))("MCP over stdio (built CLI)", () => {
  it("speaks newline-delimited JSON-RPC and keeps stdout clean", async () => {
    const child = spawn(process.execPath, ["dist/cli.mjs", "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    child.stdin.write("{not json}\n");
    send(call("check_commit", { message: "x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>" }, 3));
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe("howmuchai");
    expect(msgs.find((m) => m.id === 2).result.tools).toHaveLength(4);
    expect(msgs.find((m) => m.id === null).error.code).toBe(-32700);
    expect(msgs.find((m) => m.id === 3).result.structuredContent.agent).toBe("cursor");
    expect(msgs).toHaveLength(4);
  });
});
