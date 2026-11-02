/** Formats a share for display: "23%", "4.2%", "<0.1%", "0%", or "—" when there is no data. */
export function formatShare(n: number, d: number): string {
  if (d === 0) return "—";
  if (n === 0) return "0%";
  const v = (100 * n) / d;
  if (v < 0.1) return "<0.1%";
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(v)}%`;
}

/** Formats a likely range of shares (0..1): "45–68%", or "62%" when both ends round to the same value. */
export function formatRange(lo: number, hi: number): string {
  const a = Math.round(lo * 100);
  const b = Math.round(hi * 100);
  return a === b ? `${a}%` : `${a}–${b}%`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[ch]!);
}

/** Median of a list of numbers (mean of the two middle values for even lengths), 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Why there is no estimate beyond signatures, as a sentence fragment ("no estimate because …"). */
export const NO_ESTIMATE: Record<string, string> = {
  "no-evidence": "this repo discloses fewer than 10 agent commits, and without that a number would be a guess",
  "setup-only": "the repo has agent setup files but discloses fewer than 10 agent commits; setup files show that agents are used, not how much, and some human commit styles look like agent text",
  "too-few-disclosed": "fewer than 10 disclosed agent commits have a message long enough to show what agent work looks like here",
  "too-little-history": "the repo has too few commits from before July 2022 to show what human work looks like here",
  "all-disclosed": "every commit already carries a signature",
  "too-few-judgeable": "fewer than 20 undisclosed commits have a message long enough to judge",
  inseparable: "this repo's human and agent commits cannot be told apart by style",
  "too-uncertain": "the possible range would be wider than 50 percentage points",
  "no-commits": "there are no commits in this period",
};

export function noEstimateReason(reason: string | null | undefined): string {
  return NO_ESTIMATE[reason ?? "no-evidence"] ?? NO_ESTIMATE["no-evidence"]!;
}
