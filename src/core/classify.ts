import type { CommitInput, Confidence, Match, PullInput, Registry, SignalKind } from "./types";

interface CompiledSignal {
  agentId: string;
  id: string;
  contains: string | null;
  kind: SignalKind;
  re: RegExp;
  confidence: Confidence;
}

export interface Classifier {
  commit(c: CommitInput): Match[];
  pull(p: PullInput): Match[];
  isIgnoredCommit(c: CommitInput): boolean;
  isIgnoredPull(p: PullInput): boolean;
}

/** Builds a classifier from a signature registry. Regexes are case-insensitive and multiline. */
export function createClassifier(reg: Registry): Classifier {
  const signals: CompiledSignal[] = [];
  for (const agent of reg.agents) {
    for (const s of agent.signals) {
      signals.push({ agentId: agent.id, id: s.id, contains: s.contains ?? null, kind: s.kind, re: new RegExp(s.pattern, "i"), confidence: s.confidence });
    }
  }
  const ignored = new Set(reg.ignoredAuthors.map((a) => a.toLowerCase()));
  // Dependency and release bots under any app name (renovate-sh-app[bot], dependabot-xyz[bot], ...).
  const depBot = /^(renovate|dependabot|mend|whitesource|snyk|greenkeeper|depfu|pyup|scala-steward|release-please|changeset|semantic-release)[\w.-]*(\[bot\])?$/i;

  const of = (kind: SignalKind) => signals.filter((s) => s.kind === kind);
  const trailer = of("commit-trailer");
  const message = of("commit-message");
  const author = of("commit-author");
  const prAuthor = of("pr-author");
  const prBody = of("pr-body");
  const prBranch = of("pr-branch");

  /** Longest line that can hold a trailer or footer; longer lines are skipped (and cannot cause slow matching). */
  const MAX_LINE = 512;
  /** Longest name, e-mail, login or branch that is matched. */
  const MAX_FIELD = 256;

  function lines(text: string | null | undefined): string[] {
    if (!text) return [];
    const out: string[] = [];
    let fence: string | null = null;
    for (const raw of text.slice(0, 262_144).split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      // Lines inside fenced code blocks are examples, not signatures (docs often show the trailers).
      const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1]![0]!;
        else if (f[1]![0] === fence) fence = null;
        continue;
      }
      if (fence !== null) continue;
      if (line.length > 0 && line.length <= MAX_LINE) out.push(line);
    }
    return out;
  }

  /** Most lines of one message that are examined; trailers and footers are short and few. */
  const MAX_LINES = 400;
  const trailerShape = /^[A-Za-z][A-Za-z-]{1,40}:/;

  /** Tests line-based signals (trailers, footers) against each line on its own. */
  function runLines(list: CompiledSignal[], ls: string[], out: Match[], kind: "trailer" | "footer") {
    const candidates = (kind === "trailer" ? ls.filter((l) => trailerShape.test(l)) : ls).slice(-MAX_LINES);
    const lower = candidates.map((l) => l.toLowerCase());
    for (const s of list) {
      for (let i = 0; i < candidates.length; i++) {
        if (s.contains && !lower[i]!.includes(s.contains)) continue;
        const m = s.re.exec(candidates[i]!);
        if (m) {
          out.push({ agentId: s.agentId, signalId: s.id, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
          break;
        }
      }
    }
  }

  /** Tests field signals (authors, logins, branches) against one short value. */
  function runField(list: CompiledSignal[], value: string | null | undefined, out: Match[]) {
    if (!value || value.length > MAX_FIELD) return;
    for (const s of list) {
      const m = s.re.exec(value);
      if (m) out.push({ agentId: s.agentId, signalId: s.id, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
    }
  }

  const agentOrder = new Map(reg.agents.map((a, i) => [a.id, i]));

  /**
   * One match per agent (the strongest one), ordered so that the first match is the primary agent:
   * high confidence before medium, then the order of agents in the registry.
   */
  function dedupe(matches: Match[]): Match[] {
    const best = new Map<string, Match>();
    for (const m of matches) {
      const cur = best.get(m.agentId);
      if (!cur || (cur.confidence === "medium" && m.confidence === "high")) best.set(m.agentId, m);
    }
    return [...best.values()].sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
        (agentOrder.get(a.agentId) ?? 1e9) - (agentOrder.get(b.agentId) ?? 1e9),
    );
  }

  return {
    commit(c) {
      const out: Match[] = [];
      const ls = lines(c.message);
      runLines(trailer, ls, out, "trailer");
      runLines(message, ls, out, "footer");
      for (const field of [c.authorLogin, c.authorName, c.authorEmail, c.committerLogin, c.committerName, c.committerEmail]) {
        runField(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out: Match[] = [];
      runField(prAuthor, p.authorLogin, out);
      runLines(prBody, lines(p.body), out, "footer");
      runField(prBranch, p.branch, out);
      return dedupe(out);
    },
    isIgnoredCommit(c) {
      if (c.parents > 1) return true; // merge commits carry no code of their own
      const login = (c.authorLogin ?? "").toLowerCase();
      const name = (c.authorName ?? "").toLowerCase();
      return ignored.has(login) || ignored.has(name) || depBot.test(login) || depBot.test(name);
    },
    isIgnoredPull(p) {
      const login = (p.authorLogin ?? "").toLowerCase();
      return ignored.has(login) || depBot.test(login);
    },
  };
}
