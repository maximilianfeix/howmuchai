/**
 * Trains the style model of the experimental "beyond signatures" estimate and writes
 * src/core/style-model.json and eval/STYLE.md.
 *
 *   tsx scripts/train-style.ts --raw .work/raw --human .work/human --control .work/control
 *
 * --raw      crawler raw data (positives: commits with a high-confidence signature, signature lines removed)
 * --human    per-repo commits from before July 2022 for the same repos (negatives, certainly human)
 * --control  2026 commits of projects with restrictive AI policies plus their pre-2022 commits (*.old.json)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClassifier } from "../src/core/classify";
import { prevalence } from "../src/core/estimate";
import { registry } from "../src/core/registry";
import { FEATURE_NAMES, features, isJudgeable, score, type StyleModel } from "../src/core/style";
const judge = (c: any) => isJudgeable(c.message);

const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1]! : d);
const RAW = arg("--raw", ".work/raw"), HUMAN = arg("--human", ".work/human"), CONTROL = arg("--control", ".work/control");
const cls = createClassifier(registry);
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const isAI = (c: any) => cls.commit(c).some((m) => m.confidence === "high");
const usable = (c: any) => !cls.isIgnoredCommit(c) && !/\[bot\]$|^copilot$/i.test(c.authorLogin ?? "");

type Ex = { x: number[]; y: number; g: string; msg: string };
const human: Record<string, any[]> = {};
for (const f of readdirSync(HUMAN)) { const d = JSON.parse(readFileSync(join(HUMAN, f), "utf8")); if (d.items.length) human[d.repo.toLowerCase()] = d.items.filter(usable); }
const current: Record<string, any[]> = {};
for (const f of walk(RAW)) { const d = JSON.parse(readFileSync(f, "utf8")); const g = d.repo.fullName.toLowerCase(); if (human[g]) current[g] = d.commits.items.filter(usable); }
const repos = Object.keys(current).sort();
const examples = (only: (g: string) => boolean): Ex[] =>
  repos.filter(only).flatMap((g) => [
    ...current[g]!.filter(isAI).map((c) => ({ x: features(c.message), y: 1, g, msg: c.message })),
    ...human[g]!.map((c) => ({ x: features(c.message), y: 0, g, msg: c.message })),
  ]);

function fit(data: Ex[], l2 = 1e-3, iters = 300, lr = 0.5): StyleModel {
  const d = data[0]!.x.length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const e of data) e.x.forEach((v, i) => (mu[i] += v / data.length));
  for (const e of data) e.x.forEach((v, i) => (sd[i] += (v - mu[i]) ** 2 / data.length));
  for (let i = 0; i < d; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  const np = data.filter((e) => e.y).length, nn = data.length - np;
  const wp = data.length / (2 * np), wn = data.length / (2 * nn);
  let w = Array(d).fill(0), b = 0;
  const z = (x: number[]) => x.reduce((s, v, i) => s + w[i] * ((v - mu[i]) / sd[i]), b);
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (const e of data) { const err = (1 / (1 + Math.exp(-z(e.x))) - e.y) * (e.y ? wp : wn); e.x.forEach((v, i) => (gw[i] += (err * (v - mu[i])) / sd[i])); gb += err; }
    w = w.map((wi, i) => wi - lr * (gw[i] / data.length + l2 * wi)); b -= (lr * gb) / data.length;
  }
  const model: StyleModel = { version: 2, trainedAt: new Date().toISOString().slice(0, 10), features: FEATURE_NAMES, weights: w.map((v) => +v.toFixed(5)), bias: +b.toFixed(5), mean: mu.map((v) => +v.toFixed(5)), scale: sd.map((v) => +v.toFixed(5)), humanMean: 0, agentMean: 0, trainedOn: { agent: data.filter((e) => e.y).length, human: data.filter((e) => !e.y).length, repos: new Set(data.map((e) => e.g)).size } };
  // Only judgeable messages are scored at inference time, so the fallback references use only those too.
  const h = data.filter((e) => !e.y && isJudgeable(e.msg)).map((e) => score(model, e.msg)), a = data.filter((e) => e.y && isJudgeable(e.msg)).map((e) => score(model, e.msg));
  model.humanMean = +(h.reduce((s, x) => s + x, 0) / h.length).toFixed(4);
  model.agentMean = +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4);
  return model;
}
function auc(sc: [number, number][]) { const s = [...sc].sort((a, b) => a[0] - b[0]); let sp = 0, np = 0; s.forEach(([, y], i) => { if (y) { sp += i + 1; np++; } }); return (sp - (np * (np + 1)) / 2) / (np * (s.length - np)); }

const fold = new Map(repos.map((g, i) => [g, i % 5]));
const models = [0, 1, 2, 3, 4].map((k) => fit(examples((g) => fold.get(g) !== k)));
const cv: [number, number][] = [];
for (const g of repos) { const m = models[fold.get(g)!]!; for (const c of current[g]!.filter(isAI)) cv.push([score(m, c.message), 1]); for (const c of human[g]!) cv.push([score(m, c.message), 0]); }
const model = fit(examples(() => true));
writeFileSync("src/core/style-model.json", JSON.stringify(model, null, 1) + "\n");

// synthetic mixtures with a known share, scored by the model that never saw the repo
const mix: Record<string, number[]> = { "0": [], "0.25": [], "0.5": [], "0.75": [], "1": [] };
let covered = 0, cases = 0;
for (const g of repos) {
  const m = models[fold.get(g)!]!;
  const hs = human[g]!.filter(judge).map((c) => score(m, c.message)), ds = current[g]!.filter(isAI).filter(judge).map((c) => score(m, c.message));
  if (hs.length < 40 || ds.length < 40) continue;
  const base = hs.filter((_, i) => i % 2 === 0), test = hs.filter((_, i) => i % 2 === 1), ref = ds.filter((_, i) => i % 2 === 0), pool = ds.filter((_, i) => i % 2 === 1);
  for (const pi of [0, 0.25, 0.5, 0.75, 1]) {
    const n = 20, na = Math.round(pi * n);
    if (pool.length < na || test.length < n - na) continue;
    const e = prevalence([...pool.slice(0, na), ...test.slice(0, n - na)], base, ref);
    if (!e) continue;
    mix[String(pi)]!.push(e.point - pi); cases++;
    if (e.lo - 1e-9 <= pi && pi <= e.hi + 1e-9) covered++;
  }
}
const pct = (x: number) => `${(100 * x).toFixed(1)}`;
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] ?? 0; };

// control projects: 2026 commits, own pre-2022 baseline, no disclosed AI → the gate keeps them at "no estimate"
const ctl: string[] = [];
for (const f of readdirSync(CONTROL).filter((f) => !f.includes(".old"))) {
  const now = JSON.parse(readFileSync(join(CONTROL, f), "utf8")).items.filter((c: any) => usable(c));
  const old = JSON.parse(readFileSync(join(CONTROL, f.replace(".json", ".old.json")), "utf8")).items.filter((c: any) => usable(c));
  if (!now.length) continue;
  const disclosed = now.filter(isAI).length;
  const e = prevalence(now.filter((c: any) => !isAI(c) && judge(c)).map((c: any) => score(model, c.message)), old.filter(judge).map((c: any) => score(model, c.message)), model.agentMean);
  ctl.push(`| ${f.replace(".json", "").replace("__", "/")} | ${disclosed} | ${e ? `${pct(e.point)}% (${pct(e.lo)}–${pct(e.hi)})` : "–"} | ${disclosed >= 10 ? "estimated" : "**not estimated** (fewer than 10 disclosed)"} |`);
}

const lines = [
  `# Style model of the experimental estimate`,
  ``,
  `Generated by \`scripts/train-style.ts\` on ${model.trainedAt}. Do not edit by hand.`,
  ``,
  `**Training data:** ${cv.filter(([, y]) => y).length.toLocaleString("en-US")} commits with a disclosed agent signature (signature lines removed) and ${cv.filter(([, y]) => !y).length.toLocaleString("en-US")} commits from before July 2022 (before coding agents) from the same ${repos.length} repositories. Commits by bot accounts are left out.`,
  ``,
  `**Features (${FEATURE_NAMES.length}):** ${FEATURE_NAMES.join(", ")}. Only the text of the commit message is used; no names, no dates, no diffs.`,
  ``,
  `## How well it separates single commits`,
  ``,
  `Area under the ROC curve with 5-fold cross-validation grouped by repository (a repository is never in training and test at once): **${auc(cv).toFixed(3)}**.`,
  ``,
  `This is not good enough to judge a single commit, and howmuchai never does. Careful human writers (mailing-list projects such as PostgreSQL or QEMU) score like agents. The model is only used for a share per repository, against that repository's own history.`,
  ``,
  `## How well it estimates a share`,
  ``,
  `Mixtures of 20 commits with a known AI share (messages long enough to judge), built from each repository's own human and agent commits, estimated with a model that never saw that repository and the repository's own pre-2022 commits as the human reference:`,
  ``,
  `| True share | Cases | Median absolute error | Mean error (bias) | 90% of errors within |`,
  `|---:|---:|---:|---:|---:|`,
  ...Object.entries(mix)
    .sort((a, b) => +a[0] - +b[0])
    .map(([k, e]) => `| ${pct(+k)}% | ${e.length} | ${pct(q(e.map(Math.abs), 0.5))} pts | ${e.reduce((s, x) => s + x, 0) / e.length >= 0 ? "+" : ""}${pct(e.reduce((s, x) => s + x, 0) / e.length)} pts | ±${pct(q(e.map(Math.abs), 0.9))} pts |`),
  ``,
  `The 90% interval contained the true share in **${pct(covered / cases)}%** of ${cases} cases.`,
  ``,
  `## Why there is a gate`,
  ``,
  `2026 commits of projects with restrictive AI policies, estimated against their own pre-2022 commits. Their writing style changed over the years without any agent (longer review trailers, longer explanations), so an ungated estimate would accuse them. howmuchai therefore only estimates when a repository itself discloses AI use (at least 10 signed commits, which become the agent reference) and, if it is older than July 2022, has at least 30 commits from before that date as the human reference. It labels the result as experimental. Agent setup files alone are not enough: in a first run with that rule, repositories such as meta/rocksdb (Meta's \"Summary: … Test Plan:\" commit format) and neovim came out near 100% without a single disclosed agent commit.`,
  ``,
  `| Project | Disclosed AI commits | Ungated estimate | Shown |`,
  `|---|---:|---:|---|`,
  ...ctl,
  ``,
];
writeFileSync("eval/STYLE.md", lines.join("\n"));
console.log(lines.filter((l) => /AUC|ROC|contained|^\| /.test(l)).join("\n"));
