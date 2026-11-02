import { escapeXml as x, formatShare } from "./format";
import { agentColor, agentName } from "./registry";
import type { Report, Section } from "./types";

export type Theme = "dark" | "light";

const SANS = "-apple-system, BlinkMacSystemFont, &#39;Segoe UI&#39;, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, &#39;SF Mono&#39;, Menlo, Consolas, monospace";

const PALETTE = {
  dark: { bg: "#101B2C", border: "#35465E", text: "#F2F5FA", muted: "#A8B7CC", accent: "#A4B5FF", none: "#66768B" },
  light: { bg: "#FFFFFF", border: "#C7D1DF", text: "#18263A", muted: "#52627A", accent: "#4056BC", none: "#66768B" },
} as const;

function markGroup(tx: number, ty: number, scale: number, ink: string, fill: string): string {
  return `<g transform="translate(${tx} ${ty}) scale(${scale})"><circle cx="154" cy="150" r="54" fill="none" stroke="${ink}" stroke-width="30"/><path d="M174 366 338 146" fill="none" stroke="${ink}" stroke-width="36" stroke-linecap="round"/><circle cx="356" cy="362" r="66" fill="none" stroke="${ink}" stroke-width="28"/><path d="M314 362a42 42 0 0 0 84 0Z" fill="${fill}"/></g>`;
}

function text(xp: number, y: number, fill: string, font: string, size: number, content: string, extra = ""): string {
  return `<text x="${xp}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" ${extra}>${x(content)}</text>`;
}

function topAgents(sec: Section, n: number): [string, number][] {
  return Object.entries(sec.byAgent)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

/** Describes the period actually covered, e.g. "last 90 days · 500 commits" or "since 2026-10-12 · 500 commits". */
export function periodLabel(r: Report): string {
  const n = r.commits.total.toLocaleString("en-US");
  if (r.commits.capped && r.commits.oldest) return `since ${r.commits.oldest.slice(0, 10)} · ${n} commits`;
  return `last ${r.window.days} days · ${n} commits`;
}

/** README card, 495×195, the size of github-readme-stats cards. */
export function renderCard(r: Report, theme: Theme = "dark"): string {
  const p = PALETTE[theme];
  const sec = r.commits;
  const share = formatShare(sec.ai, sec.total);
  const agents = topAgents(sec, 3);
  const name = r.repo.fullName.length > 34 ? `${r.repo.fullName.slice(0, 33)}…` : r.repo.fullName;
  const desc = `${share} of ${sec.total} recent commits in ${r.repo.fullName} carry a disclosed AI agent signature (${periodLabel(r)}). ${agents
    .map(([id, n]) => `${agentName(id)} ${formatShare(n, sec.total)}`)
    .join(", ")}. No signature found does not mean human-only.`;

  const parts: string[] = [];
  parts.push(`<rect x="0.5" y="0.5" width="494" height="194" rx="10" fill="${p.bg}" stroke="${p.border}"/>`);
  parts.push(text(22, 31, p.text, MONO, 16, name, `font-weight="600"`));
  parts.push(text(473, 31, p.muted, SANS, 11, r.generatedAt.slice(0, 10), `text-anchor="end"`));
  parts.push(text(20, 98, p.text, MONO, share.length > 4 ? 46 : 54, share, `font-weight="700"`));
  parts.push(text(23, 119, p.muted, SANS, 12, "AI-signed commits"));
  if (agents.length === 0) {
    parts.push(text(236, 89, p.muted, SANS, 12, sec.total === 0 ? "No commits in this period" : "No agent signatures found"));
  }
  agents.forEach(([id, n], i) => {
    const y = 66 + i * 23;
    parts.push(`<rect x="236" y="${y - 9}" width="9" height="9" rx="2" fill="${agentColor(id)}"/>`);
    parts.push(text(253, y, p.text, SANS, 12, agentName(id)));
    parts.push(text(473, y, p.text, MONO, 12, formatShare(n, sec.total), `text-anchor="end"`));
  });
  // stacked bar over all commits
  const bx = 23, by = 133, bw = 449, bh = 10;
  parts.push(`<defs><clipPath id="hm-bar"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5"/></clipPath></defs>`);
  parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5" fill="${p.none}"/>`);
  let cx = bx;
  const segs: string[] = [];
  if (sec.total > 0) {
    for (const [id, n] of topAgents(sec, 99)) {
      const w = Math.max(n > 0 ? 2 : 0, (n / sec.total) * bw);
      segs.push(`<rect x="${cx.toFixed(2)}" y="${by}" width="${w.toFixed(2)}" height="${bh}" fill="${agentColor(id)}"/>`);
      cx += w;
    }
  }
  parts.push(`<g clip-path="url(#hm-bar)">${segs.join("")}</g>`);
  parts.push(text(23, 160, p.muted, MONO, 11, periodLabel(r)));
  parts.push(text(473, 160, p.muted, SANS, 10, `${formatShare(sec.total - sec.ai, sec.total)} no signature found`, `text-anchor="end"`));
  parts.push(text(23, 181, p.muted, SANS, 10, "Disclosed signatures; a lower bound."));
  parts.push(markGroup(379, 155, 0.064453125, p.text, p.accent));
  parts.push(text(412, 178, p.text, SANS, 11, "howmuchai", `font-weight="650"`));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-labelledby="hm-t hm-d"><title id="hm-t">${x(`${r.repo.fullName}: ${share} AI-signed commits`)}</title><desc id="hm-d">${x(desc)}</desc>${parts.join("")}</svg>`;
}

/** Rough width of a string in Verdana-like 11px text, as shields.io does. */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[il.,:;|!'1]/.test(ch) ? 3.5 : /[mwMW%—]/.test(ch) ? 9.5 : /[A-Z0-9#]/.test(ch) ? 7.5 : 6.5;
  return Math.ceil(w);
}

/** Flat 20px badge: "AI-signed | 23%". */
export function renderBadge(r: Report | null, label = "AI-signed"): string {
  const value = r ? formatShare(r.commits.ai, r.commits.total) : "—";
  const lw = textWidth(label) + 14;
  const vw = textWidth(value) + 14;
  const w = lw + vw;
  const fill = r && r.commits.total > 0 ? "#4056BC" : "#52627A";
  const title = r ? `${label}: ${value} of recent commits in ${r.repo.fullName}` : `${label}: unavailable`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${x(title)}"><title>${x(title)}</title><clipPath id="hm-r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#hm-r)"><rect width="${lw}" height="20" fill="#34445A"/><rect x="${lw}" width="${vw}" height="20" fill="${fill}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana, ${SANS}" font-size="11">${`<text x="${lw / 2}" y="14">${x(label)}</text><text x="${lw + vw / 2}" y="14">${x(value)}</text>`}</g></svg>`;
}

/** shields.io endpoint JSON, see https://shields.io/badges/endpoint-badge */
export function shieldsJson(r: Report): { schemaVersion: 1; label: string; message: string; color: string; labelColor: string } {
  return { schemaVersion: 1, label: "AI-signed", message: formatShare(r.commits.ai, r.commits.total), color: "4056BC", labelColor: "34445A" };
}

/** Open Graph image, 1200×630, for shared links of a repo page. */
export function renderOg(r: Report): string {
  const p = PALETTE.dark;
  const sec = r.commits;
  const share = formatShare(sec.ai, sec.total);
  const agents = topAgents(sec, 4);
  const name = r.repo.fullName.length > 40 ? `${r.repo.fullName.slice(0, 39)}…` : r.repo.fullName;
  const parts: string[] = [];
  parts.push(`<rect width="1200" height="630" fill="${p.bg}"/>`);
  parts.push(markGroup(60, 46, 0.125, p.text, p.accent));
  parts.push(`<text x="132" y="96" fill="${p.text}" font-family="${SANS}" font-size="40" font-weight="700" letter-spacing="-1">howmuch<tspan fill="${p.accent}">ai</tspan></text>`);
  parts.push(text(1140, 92, p.muted, SANS, 24, "How much of this repo was built with AI?", `text-anchor="end"`));
  parts.push(text(60, 200, p.text, MONO, name.length > 28 ? 40 : 52, name, `font-weight="700"`));
  parts.push(text(56, 400, p.text, MONO, share.length > 4 ? 150 : 180, share, `font-weight="700" letter-spacing="-6"`));
  parts.push(text(62, 452, p.muted, SANS, 30, "of recent commits are AI-signed"));
  agents.forEach(([id, n], i) => {
    const y = 300 + i * 46;
    parts.push(`<rect x="660" y="${y - 20}" width="20" height="20" rx="4" fill="${agentColor(id)}"/>`);
    parts.push(text(696, y, p.text, SANS, 28, agentName(id)));
    parts.push(text(1140, y, p.text, MONO, 28, formatShare(n, sec.total), `text-anchor="end"`));
  });
  if (agents.length === 0) parts.push(text(660, 330, p.muted, SANS, 28, sec.total ? "No agent signatures found" : "No commits in this period"));
  const bx = 60, by = 500, bw = 1080, bh = 22;
  parts.push(`<defs><clipPath id="og-bar"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="11"/></clipPath></defs>`);
  parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="11" fill="${p.none}"/>`);
  let cx = bx;
  const segs: string[] = [];
  if (sec.total > 0) {
    for (const [id, n] of topAgents(sec, 99)) {
      const w = Math.max(3, (n / sec.total) * bw);
      segs.push(`<rect x="${cx.toFixed(2)}" y="${by}" width="${w.toFixed(2)}" height="${bh}" fill="${agentColor(id)}"/>`);
      cx += w;
    }
  }
  parts.push(`<g clip-path="url(#og-bar)">${segs.join("")}</g>`);
  parts.push(text(60, 576, p.muted, MONO, 24, periodLabel(r)));
  parts.push(text(1140, 576, p.muted, SANS, 24, "Disclosed signatures · a lower bound", `text-anchor="end"`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${parts.join("")}</svg>`;
}
