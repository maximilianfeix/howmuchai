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
      signals.push({ agentId: agent.id, kind: s.kind, re: new RegExp(s.pattern, "i"), confidence: s.confidence });
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

  /** Longest line that can hold a trailer or footer; longer lines are skipped (and cannot cause slow matching). */
  const MAX_LINE = 512;
  /** Longest name, e-mail, login or branch that is matched. */
  const MAX_FIELD = 256;

  function lines(text: string | null | undefined): string[] {
    if (!text) return [];
    const out: string[] = [];
    for (const raw of text.slice(0, 262_144).split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length > 0 && line.length <= MAX_LINE) out.push(line);
    }
    return out;
  }

  /** Tests line-based signals (trailers, footers) against each line on its own. */
  function runLines(list: CompiledSignal[], ls: string[], out: Match[]) {
    for (const s of list) {
      for (const line of ls) {
        const m = s.re.exec(line);
        if (m) {
          out.push({ agentId: s.agentId, kind: s.kind, matched: m[0].trim().slice(0, 120), confidence: s.confidence });
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
      const ls = lines(c.message);
      runLines(trailer, ls, out);
      runLines(message, ls, out);
      for (const field of [c.authorLogin, c.authorName, c.authorEmail, c.committerLogin, c.committerName, c.committerEmail]) {
        runField(author, field, out);
      }
      return dedupe(out);
    },
    pull(p) {
      const out: Match[] = [];
      runField(prAuthor, p.authorLogin, out);
      runLines(prBody, lines(p.body), out);
      runField(prBranch, p.branch, out);
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
