import "./style.css";
import { analyzeRepo, DEFAULTS, parseRepo, styleModel } from "../../src/core/analyze";
import { badgePath, cardPath, likelyBadgePath, pagePath, reportPath, topCohort, type Board, type BoardEntry } from "../../src/core/dataset";
import { escapeXml as esc, formatRange, formatShare, median, noEstimateReason } from "../../src/core/format";
import { GitHubClient, GitHubError } from "../../src/core/github";
import { agentColor, agentName, registry } from "../../src/core/registry";
import { coverageLabel, periodLabel, renderCard } from "../../src/core/render";
import type { Report, Section } from "../../src/core/types";
import { validateBoard, validateReport } from "../../src/core/validate";
import { isStats, type Stats } from "../../src/core/stats";

const BASE = import.meta.env.BASE_URL; // "/howmuchai/" or "/"
const SITE = __SITE__; // absolute site URL without trailing slash
const main = document.getElementById("main")!;
const TOKEN_KEY = "howmuchai.token";
const EXAMPLES = ["microsoft/vscode", "oven-sh/bun", "vercel/next.js", "astral-sh/uv", "anthropics/claude-code", "torvalds/linux"];

// ---------- helpers ----------

const url = (path: string) => `${BASE}${path}`;
/** Only GitHub links are ever rendered from data; anything else becomes "#". */
const safeGh = (u: string) => (/^https:\/\/github\.com\/[^\s"'<>]*$/.test(u) ? esc(u) : "#");
const abs = (path: string) => `${SITE}/${path}`;

function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i] ?? "") : ""), "");
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Copy failed. Select the text and copy it by hand.");
  }
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return "just now";
  if (mins < 90) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function setTitle(t: string) {
  document.title = t ? `${t} · howmuchai` : "howmuchai — How much of this repo was built with AI?";
}

function sortedAgents(byAgent: Record<string, number>): [string, number][] {
  return Object.entries(byAgent).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function barHtml(byAgent: Record<string, number>, total: number, cls = ""): string {
  if (total === 0) return `<div class="bar ${cls}" aria-hidden="true"></div>`;
  const segs = sortedAgents(byAgent)
    .map(([id, n]) => `<span style="width:${((100 * n) / total).toFixed(3)}%;background:${agentColor(id)}" title="${esc(agentName(id))}: ${n}"></span>`)
    .join("");
  return `<div class="bar ${cls}" aria-hidden="true">${segs}</div>`;
}

function legendHtml(sec: Section, unit: string): string {
  const items = sortedAgents(sec.byAgent).map(
    ([id, n]) => `<li><span class="sw" style="background:${agentColor(id)}"></span>${esc(agentName(id))} <span class="n">${n} · ${formatShare(n, sec.total)}</span></li>`,
  );
  items.push(`<li><span class="sw" style="background:var(--none)"></span>No signature found <span class="n">${sec.total - sec.ai} · ${formatShare(sec.total - sec.ai, sec.total)}</span></li>`);
  const hints = sec.hints
    ? `<p class="muted" style="font-size:14px;margin:4px 0 0">Plus ${sec.hints} with only a hint (${sortedAgents(sec.hintsByAgent)
        .map(([id, n]) => `${esc(agentName(id))} ${n}`)
        .join(", ")}), for example a default agent branch name. Hints are listed in the evidence but not counted.</p>`
    : "";
  return `<ul class="legend" aria-label="${esc(unit)} by agent">${items.join("")}</ul>${hints}`;
}

// ---------- data ----------

let boardCache: Promise<Board | null> | null = null;
function loadBoard(): Promise<Board | null> {
  boardCache ??= fetch(url("data/leaderboard.json"))
    .then(async (r) => {
      if (!r.ok) return null;
      const v = validateBoard(await r.json());
      return v.ok ? v.value : null;
    })
    .catch(() => null)
    .then((b) => {
      if (!b) boardCache = null; // try again on the next visit
      return b;
    });
  return boardCache;
}

async function loadStored(fullName: string): Promise<Report | null> {
  try {
    const r = await fetch(url(reportPath(fullName)));
    if (!r.ok) return null;
    // Older or damaged reports are measured live instead.
    const v = validateReport(await r.json());
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

// ---------- routing ----------

type Route = { name: "home" } | { name: "leaderboard" } | { name: "method" } | { name: "repo"; repo: string; live: boolean };

function route(): Route {
  const params = new URLSearchParams(location.search);
  const q = params.get("r");
  if (q && parseRepo(q)) return { name: "repo", repo: parseRepo(q)!, live: params.has("live") };
  let path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname.replace(/^\//, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return { name: "home" }; // malformed escape like "%" in the URL
  }
  path = path.replace(/index\.html$/, "");
  if (path.startsWith("leaderboard")) return { name: "leaderboard" };
  if (path.startsWith("method")) return { name: "method" };
  const m = /^r\/([^/]+)\/([^/]+)/.exec(path);
  if (m && parseRepo(`${m[1]}/${m[2]}`)) return { name: "repo", repo: parseRepo(`${m[1]}/${m[2]}`)!, live: params.has("live") };
  return { name: "home" };
}

/** Scrolls to the element named by the URL fragment, if there is one on the page. */
function scrollToHash(): boolean {
  if (!location.hash) return false;
  let id = location.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    return false;
  }
  const el = document.getElementById(id);
  el?.scrollIntoView();
  return el !== null;
}

function go(path: string) {
  history.pushState(null, "", url(path));
  render();
  if (!scrollToHash()) window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a");
  if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute("href");
  if (!href || !a.hasAttribute("data-path")) return;
  e.preventDefault();
  go(a.getAttribute("data-path")!);
});
window.addEventListener("popstate", render);

function fixNav(r: Route) {
  document.querySelectorAll<HTMLAnchorElement>("[data-path]").forEach((a) => {
    const p = a.getAttribute("data-path")!;
    a.href = url(p);
  });
  document.querySelectorAll<HTMLAnchorElement>(".top nav a[data-path]").forEach((a) => {
    const active = (r.name === "leaderboard" && a.dataset.path === "leaderboard/") || (r.name === "method" && a.dataset.path === "method/");
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

let firstRender = true;
/** Increases on every navigation. Async work checks it after every await and gives up when it is stale. */
let generation = 0;
let inflight: AbortController | null = null;
const current = (g: number) => g === generation;

function render() {
  const r = route();
  const g = ++generation;
  inflight?.abort();
  inflight = new AbortController();
  fixNav(r);
  if (r.name === "home") renderHome(g);
  else if (r.name === "leaderboard") void renderLeaderboard(g);
  else if (r.name === "method") {
    renderMethod();
    if (firstRender) scrollToHash(); // the browser looked for the fragment before the page existed
  }
  else void renderRepo(r.repo, r.live, g, inflight.signal);
  fixNav(r);
  if (!firstRender) main.focus({ preventScroll: true });
  firstRender = false;
}

// ---------- views ----------

function searchForm(value = ""): string {
  return html`<form class="search" id="search" role="search">
    <label for="q" class="skip">GitHub repository</label>
    <input id="q" name="q" autocomplete="off" spellcheck="false" placeholder="owner/repo or a GitHub URL" value="${esc(value)}" required />
    <button class="btn" type="submit">Measure</button>
  </form>`;
}

function bindSearch() {
  const f = document.getElementById("search") as HTMLFormElement | null;
  f?.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (f.elements.namedItem("q") as HTMLInputElement).value;
    const repo = parseRepo(v);
    if (!repo) {
      toast("Use owner/repo, e.g. vercel/next.js");
      return;
    }
    go(pagePath(repo));
  });
}

function renderHome(g: number) {
  setTitle("");
  main.innerHTML = html`
    <section class="hero">
      <h1>How much of this repo was built with AI?</h1>
      <p class="lead">Paste any public GitHub repository. howmuchai reads its recent commits and pull requests and counts the ones that carry an AI coding-agent signature: Claude Code, Copilot, Codex, Cursor, Devin, Jules and more.</p>
      ${searchForm()}
      <div class="examples" id="examples">Try: ${EXAMPLES.map((e) => `<a class="chip" href="${url(pagePath(e))}" data-path="${pagePath(e)}">${esc(e)}</a>`).join("")}</div>
    </section>
    <h2 class="section-title">Most AI-signed among the 1,000 most-starred active repos</h2>
    <div id="home-board" class="loading">Loading leaderboard</div>
    <h2 class="section-title">How it works</h2>
    <div class="steps">
      <div class="card"><h3>1 · Read the history</h3><p>The last ${DEFAULTS.days} days of the default branch, up to ${DEFAULTS.maxCommits} commits and ${DEFAULTS.maxPulls} pull requests, straight from the GitHub API.</p></div>
      <div class="card"><h3>2 · Look for signatures</h3><p>Co-author trailers, bot accounts, footers and branch names that agents leave by default. Every match links to its commit.</p></div>
      <div class="card"><h3>3 · Count, don't guess</h3><p>No AI detector, no model. A commit counts only if it says so. That makes the number a lower bound.</p></div>
    </div>
    <h2 class="section-title">In your terminal</h2>
    <pre class="cmd">npx github:maximilianfeix/howmuchai vercel/next.js</pre>
  `;
  bindSearch();
  void loadBoard().then((b) => {
    if (!current(g)) return;
    const el = document.getElementById("home-board");
    if (!el) return;
    if (!b || b.repos.length === 0) {
      el.className = "muted";
      el.textContent = "The leaderboard is being built. Check back soon.";
      return;
    }
    el.className = "";
    const cohort = topCohort(b);
    const top = cohort.filter((e) => e.total >= 30 && e.share !== null).sort((a, b2) => (b2.share ?? 0) - (a.share ?? 0)).slice(0, 8);
    el.innerHTML = boardTable(top, 1) + `<p><a href="${url("leaderboard/")}" data-path="leaderboard/">See all ${cohort.length.toLocaleString("en-US")} repos →</a></p>`;
  });
}

function boardTable(rows: BoardEntry[], start: number): string {
  return html`<table class="lb">
    <thead><tr><th class="num">#</th><th>Repository</th><th class="num">AI-signed</th><th class="num hide-sm" title="Experimental estimate of the AI share including undisclosed commits; blank where there is not enough evidence">Likely (est.)</th><th class="hide-sm">Agents</th><th class="num hide-sm">Commits</th><th class="num hide-sm">Stars</th></tr></thead>
    <tbody>${rows
      .map(
        (e, i) => html`<tr>
        <td class="num muted">${start + i}</td>
        <td class="repo"><a href="${url(pagePath(e.fullName))}" data-path="${pagePath(e.fullName)}">${esc(e.fullName)}</a></td>
        <td class="num">${formatShare(e.ai, e.total)}</td>
        <td class="num hide-sm muted">${e.likely ? formatRange(e.likely.lo, e.likely.hi) : "—"}</td>
        <td class="mini hide-sm">${barHtml(e.byAgent, e.total, "small")}</td>
        <td class="num hide-sm muted">${e.total.toLocaleString("en-US")}</td>
        <td class="num hide-sm muted">${e.stars.toLocaleString("en-US")}</td>
      </tr>`,
      )
      .join("")}</tbody></table>`;
}

async function renderRepo(repo: string, forceLive: boolean, g: number, signal: AbortSignal) {
  setTitle(repo);
  main.innerHTML = `<div class="loading" role="status">Reading ${esc(repo)}</div>`;
  let report: Report | null = null;
  let source: "stored" | "live" = "stored";
  if (!forceLive) report = await loadStored(repo);
  if (!current(g)) return;
  if (!report) {
    source = "live";
    const token = localStorage.getItem(TOKEN_KEY);
    // In the browser, do not keep the visitor waiting for long retries.
    const client = new GitHubClient({ token, attempts: 3, maxWaitMs: 10_000, timeoutMs: 20_000, signal });
    try {
      report = await analyzeRepo(repo, { client });
    } catch (e) {
      if (current(g)) renderError(repo, e);
      return;
    }
  }
  if (!current(g)) return; // the user navigated away meanwhile
  renderReport(report, source);
}

function renderError(repo: string, e: unknown) {
  let msg: string;
  if (e instanceof GitHubError && e.resetAt) {
    const mins = Math.max(1, Math.ceil((e.resetAt * 1000 - Date.now()) / 60000));
    msg = `GitHub allows 60 API requests per hour without a token, and this network has used them up. Try again in ${mins} min, or add a token below. A lookup needs about 10 requests.`;
  } else if (e instanceof GitHubError && e.status === 404) {
    msg = `${repo} was not found. It may be private, renamed or misspelled.`;
  } else if (e instanceof GitHubError && e.status === 409) {
    msg = `${repo} is empty.`;
  } else {
    msg = `Could not read ${repo}: ${e instanceof Error ? e.message : String(e)}`;
  }
  main.innerHTML = html`
    <div class="error" role="alert">${esc(msg)}</div>
    ${searchForm(repo)}
    ${tokenBox()}`;
  bindSearch();
  bindToken();
}

function tokenBox(): string {
  const has = !!localStorage.getItem(TOKEN_KEY);
  return html`<details class="card" style="margin-top:22px">
    <summary>${has ? "A GitHub token is saved in this browser" : "Use a GitHub token (optional)"}</summary>
    <p style="margin-top:10px">A token raises the limit from 60 to 5,000 requests per hour. Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with no permissions (public repositories only). It stays in this browser's local storage and is only sent to api.github.com.</p>
    <div class="search" style="margin-top:12px"><input id="tok" type="password" placeholder="github_pat_…" autocomplete="off" aria-label="GitHub token" /><button class="btn ghost" id="tok-save" type="button">Save</button>${has ? `<button class="btn ghost" id="tok-del" type="button">Remove</button>` : ""}</div>
  </details>`;
}

function bindToken() {
  document.getElementById("tok-save")?.addEventListener("click", () => {
    const v = (document.getElementById("tok") as HTMLInputElement).value.trim();
    if (!v) return;
    localStorage.setItem(TOKEN_KEY, v);
    toast("Token saved in this browser");
    render();
  });
  document.getElementById("tok-del")?.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    toast("Token removed");
    render();
  });
}

function trendHtml(sec: Section): string {
  if (sec.byMonth.length < 2) return "";
  const max = Math.max(...sec.byMonth.map((m) => m.total));
  const cols = sec.byMonth
    .map((m) => {
      const h = max ? (100 * m.total) / max : 0;
      const parts = sortedAgents(m.byAgent)
        .map(([id, n]) => `<span style="height:${m.total ? (100 * n) / m.total : 0}%;background:${agentColor(id)}"></span>`)
        .join("");
      return `<div class="col" title="${m.month}: ${m.ai} of ${m.total} AI-signed"><div class="well"><div class="stack" style="height:${h}%">${parts}</div></div><div class="lbl">${m.month.slice(5)}/${m.month.slice(2, 4)}</div></div>`;
    })
    .join("");
  return `<div class="card"><h3>By month</h3><p>AI-signed commits (color) in all commits (height).</p><div class="trend" aria-hidden="true">${cols}</div></div>`;
}


function beyondHtml(r: Report): string {
  const b = r.beyond;
  if (!b || r.commits.total === 0) return "";
  const c = r.commits;
  const pc = (x: number) => `${Math.round(100 * x)}%`;
  const setup = b.setup === null
    ? "not checked yet"
    : b.setup.length
      ? b.setup.map((s) => `<code>${esc(s.path)}</code> (${esc(agentName(s.agentId))})`).join(", ")
      : "none found";
  const authorLine = b.authors.aiAuthors
    ? `<strong>${pc(b.authors.commitsByAiAuthors / c.total)}</strong> of the commits are by ${b.authors.aiAuthors} of ${b.authors.authors} authors who disclose agent use in at least one other commit here.`
    : `No author discloses agent use in this window.`;
  let head: string;
  let explain: string;
  if (b.estimate && b.likely) {
    const e = b.estimate, l = b.likely;
    head = `<div class="stat">${pc(l.lo)}–${pc(l.hi)} <span class="muted" style="font-size:15px;font-weight:400">likely AI-involved, best estimate ${pc(l.point)}</span></div>
      <div class="bar range" aria-hidden="true"><span style="width:${(100 * (r.share ?? 0)).toFixed(2)}%;background:var(--accent)"></span><span class="band" style="margin-left:${Math.max(0, 100 * l.lo - 100 * (r.share ?? 0)).toFixed(2)}%;width:${(100 * (l.hi - l.lo)).toFixed(2)}%"></span></div>`;
    explain = `Estimated from the writing style of ${e.judged ?? c.total - c.ai - e.tooShort} undisclosed commits, compared with ${e.humanReference === "own-history" ? "this repo's own commits from before July 2022" : "typical human commits from before coding agents"} and ${e.aiReference === "repo" ? "this repo's disclosed agent commits" : "typical agent commits"}. ${e.tooShort} more are too short to carry any style signal; the range treats them as unknown (none of them at the low end, all of them at the high end).${e.bots ? ` ${e.bots} commits by bot accounts are left out and count as not AI-involved.` : ""} Made because the repo already discloses agent use.`;
  } else {
    head = `<div class="stat" style="font-size:22px">No estimate</div>`;
    explain = `No estimate because ${noEstimateReason(b.reason)}. Careful human writers can look like agents, so howmuchai only estimates where agent use is already evident.`;
  }
  return html`<div class="card beyond">
    <h3>Beyond signatures <span class="tag">experimental</span></h3>
    ${head}
    <ul class="facts">
      <li><strong>${formatShare(c.ai, c.total)}</strong> disclosed: certain, the lower bound.</li>
      <li>${authorLine}</li>
      <li>Agent setup files: ${setup}.</li>
    </ul>
    <p class="muted" style="font-size:14px;margin:0">${explain} The estimate is a range for the whole repo, never a verdict on a single commit. <a href="${url("method/#beyond")}" data-path="method/#beyond">How it is made and how well it works</a></p>
  </div>`;
}

function renderReport(r: Report, source: "stored" | "live") {
  const c = r.commits;
  const p = r.pulls;
  const share = formatShare(c.ai, c.total);
  const repoPage = abs(pagePath(r.repo.fullName));
  setTitle(`${r.repo.fullName}: ${share} AI-signed`);
  const tracked = source === "stored";
  const badgeMd = `[![AI-signed commits](${abs(badgePath(r.repo.fullName))})](${repoPage})`;
  const likelyMd = `[![AI likely](${abs(likelyBadgePath(r.repo.fullName))})](${repoPage})`;
  const cardMd = `[![howmuchai card for ${r.repo.fullName}](${abs(cardPath(r.repo.fullName, "dark"))})](${repoPage})`;
  const topAgent = sortedAgents(c.byAgent)[0];
  const tweet =
    c.total === 0
      ? `${r.repo.fullName} had no commits in the last ${r.window.days} days.`
      : `${share} of recent commits in ${r.repo.fullName} carry an AI coding-agent signature${topAgent ? ` (mostly ${agentName(topAgent[0])})` : ""}.`;
  const evidence = [...c.evidence, ...p.evidence];

  main.innerHTML = html`
    <div class="result-head">
      <h1><a href="${safeGh(r.repo.url)}">${esc(r.repo.fullName)}</a></h1>
      <div class="result-meta">★ ${r.repo.stars.toLocaleString("en-US")}${r.repo.language ? ` · ${esc(r.repo.language)}` : ""} · measured ${ago(r.generatedAt)}${
        source === "stored" ? ` · <a href="?r=${encodeURIComponent(r.repo.fullName)}&live">measure live</a>` : ""
      }</div>
    </div>
    ${r.repo.description ? `<p class="desc">${esc(r.repo.description)}</p>` : ""}
    <div class="headline">
      <div class="big">${share}</div>
      <div><p class="what">of recent commits carry an AI agent signature</p>
      <p class="period">${esc(periodLabel(r))} on <code>${esc(r.repo.defaultBranch)}</code> · ${c.ai.toLocaleString("en-US")} signed · ${c.fetched - c.total > 0 ? `${(c.fetched - c.total).toLocaleString("en-US")} merges and dependency-bot commits left out` : "merges and dependency bots left out"}</p></div>
    </div>
    ${barHtml(c.byAgent, c.total)}
    ${legendHtml(c, "Commits")}
    ${beyondHtml(r)}
    <div class="grid2">
      <div class="card">
        <h3>Pull requests</h3>
        <p>${p.total === 0 ? "No pull requests opened in this period." : `Pull requests that carry an agent signature (bot author, footer or marker).`} <span class="muted">${esc(coverageLabel(p, r, "pull requests"))}.</span></p>
        ${p.total > 0 ? `<div class="stat">${formatShare(p.ai, p.total)} <span class="muted" style="font-size:15px;font-weight:400">${p.ai} of ${p.total}</span></div>${barHtml(p.byAgent, p.total, "small")}${legendHtml(p, "Pull requests")}` : ""}
      </div>
      ${trendHtml(c)}
    </div>
    <div class="share">
      <a class="btn" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(repoPage)}">Share on X</a>
      <button class="btn ghost" id="copy-link" type="button">Copy link</button>
      <button class="btn ghost" id="dl-card" type="button">Download card (SVG)</button>
    </div>
    <details class="card"><summary>Put the badge or card in your README</summary>
      ${
        tracked
          ? `<div class="embed"><p>Badge: <img alt="AI-signed badge" src="${url(badgePath(r.repo.fullName))}" style="vertical-align:middle"></p><textarea rows="2" readonly aria-label="Badge Markdown">${esc(badgeMd)}</textarea>
             <p>Badge with the likely range (experimental; shows "≥" the disclosed share where there is no estimate): <img alt="AI likely badge" src="${url(likelyBadgePath(r.repo.fullName))}" style="vertical-align:middle"></p><textarea rows="2" readonly aria-label="Likely badge Markdown">${esc(likelyMd)}</textarea>
             <p>Card:</p><img alt="howmuchai card" src="${url(cardPath(r.repo.fullName, "dark"))}" width="495" style="max-width:100%"><textarea rows="2" readonly aria-label="Card Markdown">${esc(cardMd)}</textarea>
             <p class="muted">Updated about once a day.</p></div>`
          : `<p>This repository is not tracked yet, so there is no live badge. <a href="https://github.com/maximilianfeix/howmuchai/issues/new?template=track-repo.yml&repo=${encodeURIComponent(r.repo.fullName)}&title=${encodeURIComponent(`Track ${r.repo.fullName}`)}">Ask to track it</a> (a bot adds it and answers with the badge code), or run the <a href="https://github.com/maximilianfeix/howmuchai#github-action">GitHub Action</a> in your own repo.</p>`
      }
    </details>
    <div class="note">howmuchai counts what is <strong>disclosed</strong>: co-author trailers, agent bot accounts, default footers and branch names. People can remove these, so a low number is not proof of little AI use, and "no signature found" does not mean human-only. <a href="${url("method/")}" data-path="method/">How it works</a></div>
    <details class="card" ${evidence.length ? "" : "hidden"}><summary>Evidence (${evidence.length} newest matches)</summary>
      <ul class="evidence">${evidence
        .map(
          (e) => html`<li><a class="ref" href="${safeGh(e.url)}">${esc(e.ref)}</a><span>${esc(e.title)}</span><span class="sig"><span style="color:${agentColor(e.agentId)}">■</span> ${esc(agentName(e.agentId))} · ${esc(e.kind)} · ${esc(e.matched)}${e.confidence === "medium" ? " · hint (medium confidence)" : ""}</span></li>`,
        )
        .join("")}</ul>
    </details>
    <h2 class="section-title">Measure another repo</h2>
    ${searchForm()}
    ${source === "live" ? tokenBox() : ""}
  `;
  bindSearch();
  bindToken();
  document.getElementById("copy-link")?.addEventListener("click", () => void copy(repoPage, "Link"));
  document.getElementById("dl-card")?.addEventListener("click", () => {
    const blob = new Blob([renderCard(r, "dark")], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `howmuchai-${r.repo.fullName.replace("/", "-")}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  main.querySelectorAll("textarea").forEach((t) => t.addEventListener("focus", () => t.select()));
}

// ---------- leaderboard ----------

async function renderLeaderboard(g: number) {
  setTitle("Leaderboard");
  main.innerHTML = `<div class="loading" role="status">Loading leaderboard</div>`;
  const b = await loadBoard();
  if (!current(g)) return;
  if (!b || topCohort(b).length === 0) {
    main.innerHTML = `<h1>Leaderboard</h1><p class="muted">${b ? "The first crawl is still running. Check back soon." : "The leaderboard could not be loaded. Please try again later."}</p>`;
    return;
  }
  const cohort = topCohort(b);
  const tracked = b.repos.filter((e) => e.cohort === "tracked");
  const info = b.cohort;
  const measured = cohort.filter((e) => e.total > 0);
  const withAi = measured.filter((e) => e.ai > 0);
  const totalCommits = measured.reduce((s, e) => s + e.total, 0);
  const aiCommits = measured.reduce((s, e) => s + e.ai, 0);
  const agentRepos: Record<string, number> = {};
  for (const e of measured) for (const id of Object.keys(e.byAgent)) agentRepos[id] = (agentRepos[id] ?? 0) + 1;
  const medianShare = median(measured.map((e) => e.share ?? 0));

  main.innerHTML = html`
    <div class="prose"><h1>The AI share of popular open source</h1>
    <p class="muted">The most-starred GitHub repositories with a push in the last 30 days${info ? ` (list taken ${esc(info.selectedAt.slice(0, 10))})` : ""}, each measured over the last ${b.days} days, up to ${DEFAULTS.maxCommits} commits. ${
      info
        ? `${info.measured.toLocaleString("en-US")} of ${info.selected.toLocaleString("en-US")} measured${info.missing ? `, ${info.missing} not yet or not measurable` : ""}; ${info.capped} hit the commit cap and cover a shorter time; ${info.stale ? `${info.stale} measurements are older than 48 hours` : "all measurements are less than 48 hours old"}.`
        : ""
    } Repos tracked on request are listed separately and are not part of these numbers.</p></div>
    <div class="lb-stats">
      <div class="card"><div class="stat">${formatShare(withAi.length, measured.length)}</div><p>of active repos have at least one AI-signed commit (${withAi.length} of ${measured.length})</p></div>
      <div class="card"><div class="stat">${formatShare(aiCommits, totalCommits)}</div><p>of all ${totalCommits.toLocaleString("en-US")} commits read carry an agent signature</p></div>
      <div class="card"><div class="stat">${(medianShare * 100).toFixed(1)}%</div><p>median share per repo</p></div>
      <div class="card"><p style="margin-bottom:6px">Repos per agent</p>${sortedAgents(agentRepos)
        .slice(0, 5)
        .map(([id, n]) => `<div style="display:flex;justify-content:space-between;font-size:14px"><span><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${agentColor(id)}"></span> ${esc(agentName(id))}</span><span class="mono">${n}</span></div>`)
        .join("")}</div>
    </div>
    <div id="lb-more"></div>
    <div class="lb-controls">
      <input id="lb-q" placeholder="Filter repos" aria-label="Filter repositories" />
      <div class="seg" role="group" aria-label="Sort">
        <button type="button" data-sort="share" aria-pressed="true">Most AI-signed</button>
        <button type="button" data-sort="stars" aria-pressed="false">Most stars</button>
        <button type="button" data-sort="ai" aria-pressed="false">Most signed commits</button>
        <button type="button" data-sort="likely" aria-pressed="false">Highest estimate</button>
      </div>
      <select id="lb-agent" aria-label="Filter by agent" class="chip" style="padding:8px 10px">
        <option value="">All agents</option>
        ${registry.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}
      </select>
      ${tracked.length ? `<label class="muted" style="font-size:14px"><input type="checkbox" id="lb-tracked"> Show the ${tracked.length} repos tracked on request instead</label>` : ""}
      <a class="muted" style="margin-left:auto;font-size:14px" href="${url("data/leaderboard.json")}">Download JSON</a>
    </div>
    <div id="lb-table"></div>
    <p class="muted" style="font-size:14px">Repos with fewer than 10 commits in the window are listed last. Ask to <a href="https://github.com/maximilianfeix/howmuchai/issues/new?template=track-repo.yml">track another repo</a>.</p>
  `;
  void loadStats().then((s) => {
    const el = document.getElementById("lb-more");
    if (s && el && current(g)) el.innerHTML = statsHtml(s);
  });
  let sort = "share";
  let showTracked = false;
  const draw = () => {
    const q = (document.getElementById("lb-q") as HTMLInputElement).value.trim().toLowerCase();
    const agent = (document.getElementById("lb-agent") as HTMLSelectElement).value;
    let rows = (showTracked ? tracked : cohort).filter((e) => (!q || e.fullName.toLowerCase().includes(q)) && (!agent || (e.byAgent[agent] ?? 0) > 0));
    const key = (e: BoardEntry) =>
      sort === "stars" ? e.stars : sort === "ai" ? e.ai : sort === "likely" ? (e.likely?.point ?? -1) : e.total < 10 ? -1 : (e.share ?? -1);
    rows = rows.sort((a, z) => key(z) - key(a) || z.stars - a.stars);
    const el = document.getElementById("lb-table")!;
    el.innerHTML = rows.length ? boardTable(rows.slice(0, 300), 1) + (rows.length > 300 ? `<p class="muted">Showing 300 of ${rows.length}. Use the filter.</p>` : "") : `<p class="muted">No repos match.</p>`;
  };
  main.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((btn) =>
    btn.addEventListener("click", () => {
      sort = btn.dataset.sort!;
      main.querySelectorAll("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
      draw();
    }),
  );
  document.getElementById("lb-q")!.addEventListener("input", draw);
  document.getElementById("lb-agent")!.addEventListener("change", draw);
  document.getElementById("lb-tracked")?.addEventListener("change", (e) => {
    showTracked = (e.target as HTMLInputElement).checked;
    draw();
  });
  draw();
}

// ---------- statistics ----------

async function loadStats(): Promise<Stats | null> {
  try {
    const res = await fetch(url("data/stats.json"));
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return isStats(v) ? v : null;
  } catch {
    return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/** Monthly AI-signed share as single-series bars with direct labels, plus the language table. */
function statsHtml(s: Stats): string {
  const months = s.trend.months.filter((m) => m.total > 0);
  let trend = "";
  if (months.length >= 2) {
    const W = 560, H = 170, top = 22, bottom = 28, gap = 18;
    const max = Math.max(...months.map((m) => m.ai / m.total), 0.01);
    const bw = (W - gap * (months.length - 1)) / months.length;
    const bars = months
      .map((m, i) => {
        const share = m.ai / m.total;
        const h = Math.max(2, (share / max) * (H - top - bottom));
        const x = i * (bw + gap), y = H - bottom - h;
        const label = `${monthName(m.month)}${m.partial ? " (part of the month)" : ""}: ${formatShare(m.ai, m.total)} AI-signed, ${m.ai.toLocaleString("en-US")} of ${m.total.toLocaleString("en-US")} commits`;
        return `<g class="tbar" tabindex="0" aria-label="${esc(label)}"><title>${esc(label)}</title>
          <rect x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${H - top - bottom}" fill="transparent"/>
          <path d="M${x.toFixed(1)} ${(H - bottom).toFixed(1)}V${(y + 4).toFixed(1)}q0 -4 4 -4h${(bw - 8).toFixed(1)}q4 0 4 4V${(H - bottom).toFixed(1)}Z" fill="var(--accent)" ${m.partial ? 'fill-opacity="0.55"' : ""}/>
          <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" class="tval">${formatShare(m.ai, m.total)}</text>
          <text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tlab">${esc(monthName(m.month))}${m.partial ? "*" : ""}</text></g>`;
      })
      .join("");
    trend = html`<div class="card month-trend"><h2 style="margin-top:0">AI-signed share by month</h2>
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="AI-signed share of commits by month">${bars}<line x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" stroke="var(--border)"/></svg>
      <p class="muted" style="font-size:13px;margin:6px 0 0">The ${s.trend.repos.toLocaleString("en-US")} repos of the top cohort whose whole ${"90"}-day window was read, so every month has the same repos. * Part of the month only; months with less than a week in the window are left out. Disclosed signatures, a lower bound.</p>
      <details><summary>Table</summary><table class="lb"><thead><tr><th>Month</th><th class="num">AI-signed</th><th class="num">Commits</th></tr></thead><tbody>${months
        .map((m) => `<tr><td>${esc(monthName(m.month))}${m.partial ? " (part)" : ""}</td><td class="num">${formatShare(m.ai, m.total)}</td><td class="num muted">${m.total.toLocaleString("en-US")}</td></tr>`)
        .join("")}</tbody></table></details></div>`;
  }
  const langs = s.languages.filter((l) => l.commits > 0);
  const lang = langs.length
    ? html`<div class="card"><h2 style="margin-top:0">By language</h2><table class="lb"><thead><tr><th>Language</th><th class="num">AI-signed commits</th><th class="num hide-sm">Repos with any</th><th class="num hide-sm">Median repo</th><th class="num hide-sm">Repos</th></tr></thead><tbody>${langs
        .map(
          (l) =>
            `<tr><td>${esc(l.language)}</td><td class="num">${formatShare(l.ai, l.commits)}</td><td class="num hide-sm muted">${formatShare(l.withAi, l.repos)}</td><td class="num hide-sm muted">${(100 * l.medianShare).toFixed(1)}%</td><td class="num hide-sm muted">${l.repos}</td></tr>`,
        )
        .join("")}</tbody></table><p class="muted" style="font-size:13px;margin:6px 0 0">GitHub's main language of each repo; languages with fewer than 15 repos are under Other.</p></div>`
    : "";
  return `<div class="lb-more">${trend}${lang}</div>`;
}

// ---------- method ----------

const KIND_LABEL: Record<string, string> = {
  "commit-trailer": "Commit trailer",
  "commit-message": "Commit message",
  "commit-author": "Commit author",
  "pr-author": "PR author",
  "pr-body": "PR description",
  "pr-branch": "PR branch",
};

function renderMethod() {
  const t = styleModel.trainedOn;
  const trained = t
    ? `${t.agent.toLocaleString("en-US")} disclosed agent commits, with the signature removed, and ${t.human.toLocaleString("en-US")} commits from before coding agents in the same ${t.repos} repositories`
    : "disclosed agent commits, with the signature removed, and commits from before coding agents in the same repositories";
  setTitle("Method");
  main.innerHTML = html`<div class="prose">
    <h1>How howmuchai measures</h1>
    <p>howmuchai does not guess. It counts commits and pull requests that <strong>say</strong> an AI coding agent was involved, using the marks that agents leave by default. Every match links to the commit or pull request that contains it.</p>
    <h2>What is read</h2>
    <ul>
      <li>Commits on the default branch from the last ${DEFAULTS.days} days, newest first, up to ${DEFAULTS.maxCommits}. Busy repos reach that cap within days; the result then says "since &lt;date&gt;".</li>
      <li>Pull requests opened in the same period, up to ${DEFAULTS.maxPulls}.</li>
      <li>Merge commits and dependency bots (Dependabot, Renovate, GitHub Actions and others) are left out of both counts.</li>
      <li>A commit without its own signature counts when GitHub records it as the merge commit of a merged pull request that carries one (squash merges can drop the pull request's footer). A "(#123)" in the subject alone is not enough. The evidence then says "PR #123".</li>
      <li>Trailers and footers count only on a line of their own, so a commit that merely mentions "Generated with Claude Code" in a sentence is not counted. E-mail addresses and bot accounts must match exactly.</li>
      <li>Each commit or pull request counts once. If it carries signatures of two agents, it is attributed to the first in the table below.</li>
    </ul>
    <h2>Why the number is a lower bound</h2>
    <ul>
      <li>Most agents can be told not to add their signature, and many people turn it off.</li>
      <li>Squash merges can drop trailers, and code pasted from a chat window leaves no mark.</li>
      <li>A signature says an agent was involved, not how many lines it wrote. A one-line fix and a full rewrite count the same.</li>
      <li>Some signals are only hints (marked "medium"), for example default branch names like <code>codex/</code>, which a person can also choose. Hints are shown in the evidence list but never counted in the numbers.</li>
    </ul>
    <p>So: a high number means a lot of disclosed AI involvement. A low number does not mean little AI use. "No signature found" never means human-only.</p>
    <h2>Signatures</h2>
    <p>Kept in <a href="https://github.com/maximilianfeix/howmuchai/blob/main/signatures/agents.json">signatures/agents.json</a>. Missing an agent or found a false match? <a href="https://github.com/maximilianfeix/howmuchai/issues/new/choose">Open an issue</a>.</p>
  </div>
  <table class="agents-table">
    <thead><tr><th>Agent</th><th>Where</th><th>Pattern (case-insensitive)</th><th>Confidence</th></tr></thead>
    <tbody>${registry.agents
      .flatMap((a) =>
        a.signals.map(
          (s, i) => html`<tr>${i === 0 ? `<td rowspan="${a.signals.length}"><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${a.color}"></span> ${esc(a.name)}</td>` : ""}<td>${KIND_LABEL[s.kind] ?? s.kind}</td><td><code>${esc(s.pattern)}</code>${s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ""}</td><td>${s.confidence}</td></tr>`,
        ),
      )
      .join("")}</tbody>
  </table>
  <div class="prose"><h2 id="beyond">Beyond signatures (experimental)</h2>
    <p>Many people remove agent signatures, so a repo built entirely with agents can show a low disclosed number. Each report therefore adds three pieces of evidence. None of them changes the headline number, the badge, the card or the leaderboard ranking.</p>
    <ul>
      <li><strong>Authors who disclose agent use.</strong> The share of commits written by people who sign at least one other commit in the window with an agent signature. It shows how much of the work comes from agent users, not that every one of their commits was made with an agent.</li>
      <li><strong>Agent setup files</strong> on the default branch, such as <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>.cursor/</code>, <code>GEMINI.md</code> or <code>.github/copilot-instructions.md</code>. They prove that agents are set up, not how much they wrote.</li>
      <li><strong>A style estimate</strong>: a small logistic model scores each commit message (length, structure, bullets, sentence count, wording and more; no names, no dates). It was trained on ${trained}. The share of the undisclosed commits is estimated by comparing their average score with the repo's own commits from before July 2022 and with its disclosed agent commits (adjusted classify-and-count), with a 90% bootstrap interval.</li>
    </ul>
    <p><strong>How well it works.</strong> On mixtures of 20 commits with a known AI share the median absolute error is about 3–10 percentage points (less for repos with more commits) and the 90% interval held the true share in all 125 test cases (<a href="https://github.com/maximilianfeix/howmuchai/blob/main/eval/STYLE.md">eval/STYLE.md</a>). On single commits the model is not reliable enough to judge anyone, and careful human writers (for example in PostgreSQL or QEMU) score like agents. That is why an estimate is only made when the repo itself discloses at least 10 agent commits (they show what agent work looks like in that repo) and, if it is older than July 2022, has at least 30 commits from before that date (they show what human work looks like there). Agent setup files are shown as evidence but never enough for an estimate; some company commit formats (for example "Summary: … Test Plan: …") read like agent text.</p>
  </div>
  <div class="prose"><h2>Privacy</h2><p>Lookups run in your browser against the public GitHub API. There is no server, no tracking and no analytics. A token you save stays in your browser.</p></div>`;
}

render();
