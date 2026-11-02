// Preloaded with `node --import` into the shipped CLI and Action bundles. Replaces fetch with a fake
// GitHub API that serves the fixture named in MOCK_GITHUB. Requests must still go to api.github.com.
import { readFileSync } from "node:fs";

const fx = JSON.parse(readFileSync(process.env.MOCK_GITHUB, "utf8"));
const log = process.env.MOCK_LOG;

globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.origin !== "https://api.github.com") throw new Error(`unexpected request to ${u.origin}`);
  if (log) {
    const auth = init?.headers?.Authorization ?? "";
    (await import("node:fs")).appendFileSync(log, `${u.pathname}${u.search} auth=${auth ? "yes" : "no"}\n`);
  }
  if (fx.status) return new Response(JSON.stringify({ message: fx.message ?? "error" }), { status: fx.status, headers: fx.headers ?? {} });
  const page = Number(u.searchParams.get("page") ?? 1);
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "0" } });
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return json(fx.repo);
  if (u.pathname.endsWith("/commits")) return json(page === 1 ? fx.commits : []);
  if (u.pathname.endsWith("/pulls")) return json(page === 1 ? fx.pulls ?? [] : []);
  return new Response("{}", { status: 404 });
};
