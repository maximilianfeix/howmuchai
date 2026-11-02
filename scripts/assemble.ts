/**
 * Turns the Vite build plus the crawler's data into the deployable site:
 * copies data/badges/cards, writes a static page with Open Graph tags and an OG image for every
 * measured repo, the leaderboard and method pages, 404.html, sitemap.xml and robots.txt.
 *
 *   tsx scripts/assemble.ts --site dist/site --data .data [--no-og]
 */
import { Resvg } from "@resvg/resvg-js";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ogPath, pagePath } from "../src/core/dataset";
import { escapeXml, formatShare } from "../src/core/format";
import { agentName } from "../src/core/registry";
import { periodLabel, renderOg } from "../src/core/render";
import { validateBoard, validateReport } from "../src/core/validate";
import type { Report } from "../src/core/types";

const args = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const SITE_DIR = arg("--site", "dist/site");
const DATA = arg("--data", ".data");
const OG = !args.includes("--no-og");
const SITE = (process.env.HOWMUCHAI_SITE ?? "https://maximilianfeix.github.io/howmuchai").replace(/\/$/, "");

const shell = readFileSync(join(SITE_DIR, "index.html"), "utf8");

function write(rel: string, content: string | Buffer) {
  const p = join(SITE_DIR, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function page(opts: { title: string; description: string; og: string; url: string }): string {
  const t = escapeXml(opts.title);
  const d = escapeXml(opts.description);
  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${d}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${t}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${d}"`)
    .replaceAll("%HOWMUCHAI_OG%", opts.og)
    .replaceAll("%HOWMUCHAI_URL%", opts.url)
    .replace("</head>", `    <link rel="canonical" href="${opts.url}" />\n  </head>`);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// 0. refuse to build a site from invalid data
const problems: string[] = [];
const boardFile = join(DATA, "data/leaderboard.json");
if (existsSync(boardFile)) {
  const vb = validateBoard(JSON.parse(readFileSync(boardFile, "utf8")));
  if (!vb.ok) problems.push(`leaderboard: ${vb.errors.join("; ")}`);
}
for (const f of walk(join(DATA, "data/repos")).filter((f) => f.endsWith(".json"))) {
  try {
    const v = validateReport(JSON.parse(readFileSync(f, "utf8")));
    if (!v.ok) problems.push(`${f}: ${v.errors.slice(0, 3).join("; ")}`);
  } catch (e) {
    problems.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (problems.length) {
  console.error(`invalid data, nothing assembled:\n${problems.slice(0, 30).join("\n")}`);
  process.exit(1);
}

// 1. data, badges and cards
for (const d of ["data", "badge", "card"]) {
  if (existsSync(join(DATA, d))) cpSync(join(DATA, d), join(SITE_DIR, d), { recursive: true });
}

// 2. top-level pages
const defaultOg = `${SITE}/og.png`;
const home = page({
  title: "howmuchai — How much of this repo was built with AI?",
  description:
    "Paste any public GitHub repo and see which share of recent commits and pull requests carry an AI coding-agent signature: Claude Code, Copilot, Codex, Cursor, Devin, Jules and more. Open source, open evidence.",
  og: defaultOg,
  url: `${SITE}/`,
});
write("index.html", home);
write("404.html", home.replace(`<link rel="canonical" href="${SITE}/" />`, ""));
write(
  "leaderboard/index.html",
  page({
    title: "The AI share of popular open source · howmuchai",
    description: "How many commits in the 1,000 most-starred active GitHub repos carry an AI coding-agent signature. Updated continuously.",
    og: defaultOg,
    url: `${SITE}/leaderboard/`,
  }),
);
write(
  "method/index.html",
  page({
    title: "How howmuchai measures · howmuchai",
    description: "Which commit trailers, bot accounts, footers and branch names howmuchai counts, and why the result is a lower bound.",
    og: defaultOg,
    url: `${SITE}/method/`,
  }),
);

// 3. one page and OG image per measured repo
const urls = [`${SITE}/`, `${SITE}/leaderboard/`, `${SITE}/method/`];
const reports = walk(join(DATA, "data/repos")).filter((f) => f.endsWith(".json"));
let ogCount = 0;
for (const f of reports) {
  const r = JSON.parse(readFileSync(f, "utf8")) as Report;
  const share = formatShare(r.commits.ai, r.commits.total);
  const top = Object.entries(r.commits.byAgent).sort((a, b) => b[1] - a[1])[0];
  const url = `${SITE}/${pagePath(r.repo.fullName)}`;
  const description =
    r.commits.total === 0
      ? `${r.repo.fullName} had no commits in the last ${r.window.days} days.`
      : `${share} of ${r.commits.total} recent commits in ${r.repo.fullName} carry an AI coding-agent signature${top ? `, most of them ${agentName(top[0])}` : ""} (${periodLabel(r)}). Lower bound of disclosed AI use.`;
  write(
    join(pagePath(r.repo.fullName), "index.html"),
    page({ title: `${r.repo.fullName}: ${share} AI-signed commits · howmuchai`, description, og: OG ? `${SITE}/${ogPath(r.repo.fullName)}` : defaultOg, url }),
  );
  urls.push(url);
  if (OG) {
    const png = new Resvg(renderOg(r), {
      fitTo: { mode: "width", value: 1200 },
      font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
    })
      .render()
      .asPng();
    write(ogPath(r.repo.fullName), png);
    ogCount++;
  }
}

// 4. sitemap and robots
write(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n")}\n</urlset>\n`,
);
write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`assembled ${reports.length} repo pages, ${ogCount} OG images`);
