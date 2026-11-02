import { createClassifier } from "../src/core/classify";
import { registry } from "../src/core/registry";
import type { Registry } from "../src/core/types";

export interface GroundTruthItem {
  id: string;
  stratum: string;
  label: "signature" | "prose" | "hint" | "none";
  agent: string | null;
  rationale: string;
  type: "commit" | "pull";
  repo: string;
  url: string;
  [field: string]: unknown;
}

export interface SignalStats {
  id: string;
  confidence: string;
  tp: number;
  fp: number;
}

export interface EvalResult {
  items: number;
  tp: number;
  fp: number;
  fn: number;
  wrongAgent: number;
  failures: { id: string; url: string; problem: string }[];
  bySignal: SignalStats[];
}

/** Runs the classifier over labelled items. Only high-confidence matches count, as in the reports. */
export function evaluate(items: GroundTruthItem[], reg: Registry = registry): EvalResult {
  const cls = createClassifier(reg);
  const stats = new Map<string, SignalStats>();
  for (const a of reg.agents) for (const s of a.signals) stats.set(s.id, { id: s.id, confidence: s.confidence, tp: 0, fp: 0 });
  const res: EvalResult = { items: items.length, tp: 0, fp: 0, fn: 0, wrongAgent: 0, failures: [], bySignal: [] };
  for (const it of items) {
    const x = it as Record<string, any>;
    const matches =
      it.type === "commit"
        ? cls.commit({ sha: "x", date: "", parents: 1, url: it.url, message: x.message ?? "", authorName: x.authorName, authorEmail: x.authorEmail, authorLogin: x.authorLogin, committerName: x.committerName, committerEmail: x.committerEmail, committerLogin: x.committerLogin })
        : cls.pull({ number: 1, title: x.title ?? "", body: x.body ?? null, authorLogin: x.authorLogin ?? null, branch: x.branch ?? "", createdAt: "", mergedAt: null, url: it.url });
    const high = matches.filter((m) => m.confidence === "high");
    const primary = high[0];
    if (it.label === "signature") {
      if (!primary) {
        res.fn++;
        res.failures.push({ id: it.id, url: it.url, problem: `missed ${it.agent} signature` });
      } else if (primary.agentId !== it.agent) {
        res.wrongAgent++;
        res.failures.push({ id: it.id, url: it.url, problem: `attributed to ${primary.agentId}, expected ${it.agent}` });
      } else {
        res.tp++;
        for (const m of high.filter((m) => m.agentId === it.agent)) stats.get(m.signalId)!.tp++;
      }
    } else if (primary) {
      res.fp++;
      res.failures.push({ id: it.id, url: it.url, problem: `counted as ${primary.agentId} (${primary.signalId}) but labelled ${it.label}` });
      for (const m of high) stats.get(m.signalId)!.fp++;
    }
  }
  res.bySignal = [...stats.values()];
  return res;
}

export function precision(s: SignalStats): string {
  const n = s.tp + s.fp;
  return n === 0 ? "unvalidated" : `${((100 * s.tp) / n).toFixed(0)}% (${s.tp}/${n})`;
}
