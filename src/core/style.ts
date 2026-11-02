/**
 * Style features of a commit message, used by the experimental estimate of undisclosed AI involvement.
 * Signature lines are removed first, so the model can never learn the signature itself.
 * Trained by scripts/train-style.ts; weights live in style-model.json.
 */
const SIG = /^\s*(co-authored-by|assisted-by|claude-session|copilot-session|amp-thread(-id)?)\s*:/i;
const SIG_TEXT = /generated (with|by)|claude\.ai\/code|🤖|cursor\.com|devin\.ai|capy\.ai|chatgpt\.com\/codex/i;

/** The message without any line that could carry an agent signature. */
export function stripSignatures(m: string): string {
  return m
    .slice(0, 65_536)
    .split("\n")
    .filter((l) => !SIG.test(l) && !SIG_TEXT.test(l))
    .join("\n")
    .replace(/^aider: /i, "")
    .replace(/ \(aider\)$/im, "")
    .trim();
}
const strip = stripSignatures;

const TRAILER = /^[A-Za-z][A-Za-z-]{1,40}:\s+\S/;
const HUMAN_TRAILER = /^(reviewed-by|acked-by|tested-by|reported-by|suggested-by|reported-and-tested-by|cc|author|discussion|backpatch-through|link|closes|fixes|bug|signed-off-by|change-id|bug-url|pr-url|reviewed-on)\s*:/i;
export function features(raw: string): number[] {
  const m = strip(raw);
  const lines = m.split("\n");
  // Project conventions are not style: the conventional-commit prefix and the squash suffix "(#123)" are
  // removed before measuring (grafana/loki adopted conventional commits in 2024 and looked like an agent).
  const subj = (lines[0] ?? "").replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/\s*\(#\d+\)$/, "");
  const rest = lines.slice(1);
  const trailers = rest.filter((l) => TRAILER.test(l.trim()));
  const prose = rest.filter((l) => l.trim() && !TRAILER.test(l.trim()) && !/^\s*(https?:\/\/|\[\d+\]|>)/.test(l));
  const body = prose.join("\n");
  const l1 = (x: number) => Math.log1p(x);
  const words = body.split(/\s+/).filter(Boolean);
  return [
    l1(subj.length),
    l1(body.length),
    l1(prose.length),
    l1((body.match(/^\s*[-*•] /gm) ?? []).length),
    l1((m.match(/`/g) ?? []).length),
    +/\*\*[^*]+\*\*|^#{1,3} /m.test(body),
    +/[—→]/.test(m),
    l1((body.match(/[.!?](\s|$)/g) ?? []).length),
    prose.length ? Math.min(1, prose.filter((l) => l.length > 76).length / prose.length) : 0,
    prose.length ? +prose.every((l) => l.length <= 72) : 0,
    l1(trailers.filter((l) => HUMAN_TRAILER.test(l.trim())).length),
    l1(prose.reduce((mx, l) => (l.length > mx ? l.length : mx), 0)),
    +/^\s*\d+\.\s/m.test(body),
    +/\b(this (change|commit|pr|patch)|so that|instead of|which means)\b/i.test(body),
    +/[a-z]\.  [A-Z]/.test(m), // two spaces after a full stop
    words.length ? l1(words.reduce((s, w) => s + w.length, 0) / words.length) : 0,
    l1((body.match(/\b(we|I|I'm|I've|we're|let's)\b/g) ?? []).length), // first person
    +/[!?]{2,}|:\)|;\)|\blol\b|\bhmm\b/i.test(m),
    l1((subj.match(/[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]+|\w+\(\)/g) ?? []).length), // identifiers in subject
  ];
}
export const FEATURE_NAMES = ["log subject length (without prefix)", "log prose length", "log prose lines", "log bullets", "log backticks", "markdown bold/heading", "em dash/arrow", "log sentences", "long-line share", "wrapped at 72", "human review trailers", "log longest line", "numbered list", "explanatory phrases", "two spaces after a full stop", "average word length", "first person", "informal", "identifiers in subject"];

/** Messages this short carry no style signal; they are reported as "too short to judge". */
export function isJudgeable(message: string): boolean {
  // A one-line message carries too little style to judge; a body line of some length is needed.
  const rest = stripSignatures(message).split("\n").slice(1);
  return rest.some((l) => l.trim().length >= 20 && !TRAILER.test(l.trim()));
}

export interface StyleModel {
  version: number;
  trainedAt: string;
  features: string[];
  weights: number[];
  bias: number;
  mean: number[];
  scale: number[];
  /** Mean score of human commits (before July 2022) and of disclosed agent commits in the training data. */
  humanMean: number;
  agentMean: number;
  /** Size of the training data. Missing in models before version 2. */
  trainedOn?: { agent: number; human: number; repos: number };
}

export function score(model: StyleModel, message: string): number {
  const x = features(message);
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i]! * ((x[i]! - model.mean[i]!) / model.scale[i]!);
  return 1 / (1 + Math.exp(-z));
}
