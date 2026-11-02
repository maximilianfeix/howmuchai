/** Formats a share for display: "23%", "4.2%", "<0.1%", "0%", or "—" when there is no data. */
export function formatShare(n: number, d: number): string {
  if (d === 0) return "—";
  if (n === 0) return "0%";
  const v = (100 * n) / d;
  if (v < 0.1) return "<0.1%";
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(v)}%`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[ch]!);
}
