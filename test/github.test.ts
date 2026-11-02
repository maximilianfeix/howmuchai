import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/core/github";

/** A fake GitHub API: `n` commits and `pulls` pull requests, newest first, paginated like the real one. */
function fakeApi(n: number, pulls: { created: string }[] = []) {
  const commits = Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`,
    html_url: `https://github.com/o/r/commit/sha${i}`,
    commit: { message: `c${i}`, author: { name: "a", email: "a@x", date: "2026-10-01T00:00:00Z" }, committer: { name: "a", email: "a@x", date: "2026-10-01T00:00:00Z" } },
    author: { login: "a" },
    committer: { login: "a" },
    parents: [{}],
  }));
  const prs = pulls.map((p, i) => ({ number: i + 1, title: "t", body: "", user: { login: "a" }, head: { ref: "b" }, created_at: p.created, merged_at: null, html_url: "u" }));
  const calls: string[] = [];
  const fetch = async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const page = Number(u.searchParams.get("page") ?? 1);
    const list = u.pathname.endsWith("/commits") ? commits : u.pathname.endsWith("/pulls") ? prs : [];
    const body = list.slice((page - 1) * per, page * per);
    return new Response(JSON.stringify(body), { status: 200, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "0" } });
  };
  return { client: new GitHubClient({ fetch: fetch as typeof globalThis.fetch }), calls };
}

const since = "2026-08-01T00:00:00Z";

describe("commit pagination (#5)", () => {
  const cases: [number, number, number, boolean][] = [
    // [available, max, returned, capped]
    [60, 50, 50, true],
    [50, 50, 50, false],
    [49, 50, 49, false],
    [100, 100, 100, false],
    [101, 100, 100, true],
    [99, 100, 99, false],
    [200, 100, 100, true],
    [500, 500, 500, false],
    [501, 500, 500, true],
    [0, 500, 0, false],
  ];
  for (const [n, max, want, capped] of cases) {
    it(`${n} available, max ${max} → ${want}, capped=${capped}`, async () => {
      const { client } = fakeApi(n);
      const r = await client.commits("o/r", since, max);
      expect(r.items).toHaveLength(want);
      expect(r.capped).toBe(capped);
    });
  }
  it("passes the upper bound of the window", async () => {
    const { client, calls } = fakeApi(3);
    await client.commits("o/r", since, 10, "2026-11-02T00:00:00Z");
    expect(calls[0]).toContain("until=2026-11-02");
  });
});

describe("pull request pagination (#5)", () => {
  const day = (d: number) => new Date(Date.parse("2026-11-01T00:00:00Z") - d * 86_400_000).toISOString();
  it("stops at the start of the window and is complete", async () => {
    const { client } = fakeApi(0, [...Array.from({ length: 10 }, (_, i) => ({ created: day(i) })), { created: day(200) }]);
    const r = await client.pulls("o/r", since, 300);
    expect(r.items).toHaveLength(10);
    expect(r.capped).toBe(false);
  });
  it("is capped when more PRs are in the window than allowed", async () => {
    const { client } = fakeApi(0, Array.from({ length: 150 }, () => ({ created: day(1) })));
    const r = await client.pulls("o/r", since, 120);
    expect(r.items).toHaveLength(120);
    expect(r.capped).toBe(true);
  });
  it("is complete when exactly max PRs are in the window", async () => {
    const { client } = fakeApi(0, [...Array.from({ length: 100 }, () => ({ created: day(1) })), { created: day(200) }]);
    const r = await client.pulls("o/r", since, 100);
    expect(r.items).toHaveLength(100);
    expect(r.capped).toBe(false);
  });
  it("leaves out PRs opened after the measurement started", async () => {
    const { client } = fakeApi(0, [{ created: "2026-12-01T00:00:00Z" }, { created: day(1) }]);
    const r = await client.pulls("o/r", since, 10, "2026-11-02T00:00:00Z");
    expect(r.items).toHaveLength(1);
  });
});
