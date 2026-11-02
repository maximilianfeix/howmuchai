import type { CommitInput, Confidence, Match, PullInput, Registry, SignalKind } from "./types";

interface CompiledSignal {
  agentId: string;
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
      signals.push({ agentId: agent.id, kind: s.kind, re: new RegExp(s.pattern, "im"), confidence: s.confidence });
    }
  }
  const ignored = new Set(reg.ignoredAuthors.map((a) => a.toLowerCase()));

  const of = (kind: SignalKind) => signals.filter((s) => s.kind === kind);
  const trailer = of("commit-trailer");
  const message = of("commit-message");
  const author = of("commit-author");
  const prAuthor = of("pr-author");
  const prBody = of("pr-body");
  const prBranch = of("pr-branch");

  function run(list: CompiledSignal[], text: string | null | undefined, out: Match[]) {
    if (!text) return;
    for (const s of list) {
      const m = s.re.exec(text);
      if (m) out.push({ agentId: s.agentId, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
    }
  }

  function dedupe(matches: Match[]): Match[] {
    const seen = new Set<string>();
    return matches.filter((m) => {
      const k = m.agentId;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  return {
    commit(c) {
      const out: Match[] = [];
      run(trailer, c.message, out);
      run(message, c.message, out);
      for (const field of [c.authorLogin, c.authorName, c.authorEmail, c.committerLogin, c.committerName, c.committerEmail]) {
        run(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out: Match[] = [];
      run(prAuthor, p.authorLogin, out);
      run(prBody, p.body, out);
      run(prBranch, p.branch, out);
      return dedupe(out);
    },
    isIgnoredCommit(c) {
      if (c.parents > 1) return true; // merge commits carry no code of their own
      const login = (c.authorLogin ?? "").toLowerCase();
      const name = (c.authorName ?? "").toLowerCase();
      return ignored.has(login) || ignored.has(name);
    },
    isIgnoredPull(p) {
      return ignored.has((p.authorLogin ?? "").toLowerCase());
    },
  };
}
