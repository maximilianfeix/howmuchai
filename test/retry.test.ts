import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, NetworkError, parseRetryAfter } from "../src/core/github";

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | "network";

function client(steps: Step[], opts: { attempts?: number; maxWaitMs?: number } = {}) {
  const waits: number[] = [];
  let i = 0;
  const fetch = async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(s.body ?? []), { status: s.status, headers: s.headers ?? {} });
  };
  const c = new GitHubClient({ fetch: fetch as typeof globalThis.fetch, sleep: async (ms) => void waits.push(ms), random: () => 0.5, ...opts });
  return { c, waits, calls: () => i };
}

describe("GitHub client retries (#6)", () => {
  it("recovers from a network error and a 502", async () => {
    const { c, waits, calls } = client(["network", { status: 502 }, { status: 200, body: { ok: 1 } }]);
    expect(await c.get("/x")).toEqual({ ok: 1 });
    expect(calls()).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it("gives up after the last attempt and throws the last error", async () => {
    const { c, calls } = client([{ status: 503 }], { attempts: 3 });
    await expect(c.get("/x")).rejects.toMatchObject({ status: 503 });
    expect(calls()).toBe(3);
  });

  it("honours Retry-After in seconds for a secondary rate limit", async () => {
    const { c, waits } = client([
      { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "7" } },
      { status: 200, body: [] },
    ]);
    await c.get("/x");
    expect(waits).toEqual([7000]);
  });

  it("honours Retry-After as an HTTP date", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(parseRetryAfter("Mon, 02 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
  });

  it("waits about a minute for a secondary limit without a header", async () => {
    const { c, waits } = client([{ status: 403, body: { message: "You have triggered an abuse detection mechanism." } }, { status: 200, body: [] }]);
    await c.get("/x");
    expect(waits[0]).toBeGreaterThanOrEqual(30_000);
  });

  it("fails fast when Retry-After is longer than the limit", async () => {
    const { c, calls } = client([{ status: 429, headers: { "retry-after": "600" } }], { maxWaitMs: 60_000 });
    await expect(c.get("/x")).rejects.toBeInstanceOf(GitHubError);
    expect(calls()).toBe(1);
  });

  it("does not retry an ordinary 403, 404 or 451", async () => {
    for (const status of [403, 404, 451]) {
      const { c, calls } = client([{ status, body: { message: "Forbidden" } }]);
      await expect(c.get("/x")).rejects.toMatchObject({ status });
      expect(calls()).toBe(1);
    }
  });

  it("reports the primary rate limit with its reset time instead of waiting", async () => {
    const { c, calls } = client([{ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793620000", "x-ratelimit-limit": "60" } }]);
    await expect(c.get("/x")).rejects.toMatchObject({ resetAt: 1793620000 });
    expect(calls()).toBe(1);
  });

  it("treats an empty repository as no commits, but other 409s as errors", async () => {
    const empty = client([{ status: 409, body: { message: "Git Repository is empty." } }]);
    expect(await empty.c.commits("o/r", "2026-08-01T00:00:00Z", 10)).toEqual({ items: [], capped: false });
    const other = client([{ status: 409, body: { message: "Conflict" } }]);
    await expect(other.c.commits("o/r", "2026-08-01T00:00:00Z", 10)).rejects.toMatchObject({ status: 409 });
  });

  it("wraps network failures", async () => {
    const { c } = client(["network"], { attempts: 1 });
    await expect(c.get("/x")).rejects.toBeInstanceOf(NetworkError);
  });
});
