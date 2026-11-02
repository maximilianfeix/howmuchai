import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/signals.json";
import { createClassifier } from "../src/core/classify";
import { registry } from "../src/core/registry";

const fx = fixtures as Record<string, { pos: string[]; neg: string[] }>;
const all = registry.agents.flatMap((a) => a.signals.map((s) => ({ agent: a.id, ...s })));

describe("signature registry", () => {
  it("has unique, well-formed signal ids", () => {
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of all) expect(s.id.startsWith(`${s.agent}/`)).toBe(true);
  });

  it("has fixtures for every signal, and no fixtures for unknown signals", () => {
    for (const s of all) {
      expect(fx[s.id], `fixtures for ${s.id}`).toBeDefined();
      expect(fx[s.id]!.pos.length, `positive fixtures for ${s.id}`).toBeGreaterThan(0);
      expect(fx[s.id]!.neg.length, `negative fixtures for ${s.id}`).toBeGreaterThan(0);
    }
    const known = new Set(all.map((s) => s.id));
    for (const id of Object.keys(fx)) expect(known.has(id), `unknown fixture ${id}`).toBe(true);
  });

  for (const s of all) {
    describe(s.id, () => {
      const re = new RegExp(s.pattern, "i");
      // Same rule as the classifier: trailers and footers are matched line by line, fields as a whole.
      const lineBased = s.kind === "commit-trailer" || s.kind === "commit-message" || s.kind === "pr-body";
      const test = (t: string) => (lineBased ? t.split("\n").some((l) => re.test(l.replace(/\r$/, ""))) : re.test(t));
      it("matches its positive examples", () => {
        for (const t of fx[s.id]?.pos ?? []) expect(test(t), JSON.stringify(t)).toBe(true);
      });
      it("rejects its negative examples", () => {
        for (const t of fx[s.id]?.neg ?? []) expect(test(t), JSON.stringify(t)).toBe(false);
      });
    });
  }
});

describe("adversarial input", () => {
  const cls = createClassifier(registry);
  const base = { sha: "a", date: "2026-10-01T00:00:00Z", url: "u", parents: 1 };
  it("handles huge messages and bodies quickly", () => {
    const evil = [
      "Co-authored-by: " + "Claude ".repeat(20000) + "<",
      "Co-authored-by:" + " ".repeat(60000) + "x",
      ("generated with " + "[".repeat(5000)).repeat(10),
      "a\n".repeat(50000),
      "Co-authored-by: " + "(codex)".repeat(9000),
    ];
    const t0 = performance.now();
    for (const m of evil) {
      cls.commit({ ...base, message: m, authorName: m.slice(0, 5000), authorEmail: m.slice(0, 5000) });
      cls.pull({ number: 1, title: "t", body: m, authorLogin: m.slice(0, 200), branch: m.slice(0, 300), createdAt: base.date, mergedAt: null, url: "u" });
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("handles many mid-length trailer-shaped lines quickly", () => {
    const line = "Co-authored-by:" + " ".repeat(240) + "(codex)".repeat(30);
    const msg = Array.from({ length: 2000 }, () => line).join("\n");
    const foot = Array.from({ length: 2000 }, () => "generated with " + "[".repeat(490)).join("\n");
    const t0 = performance.now();
    cls.commit({ ...base, message: msg + "\n" + foot });
    cls.pull({ number: 1, title: "t", body: foot, authorLogin: "x", branch: "y", createdAt: base.date, mergedAt: null, url: "u" });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("fenced code blocks (round 2, #27)", () => {
  const cls = createClassifier(registry);
  const pull = (body: string) => cls.pull({ number: 1, title: "t", body, authorLogin: "dev", branch: "docs/x", createdAt: "", mergedAt: null, url: "u" });
  it("does not count trailers or footers shown as examples", () => {
    expect(pull("Docs:\n\n```\nCo-authored-by: Claude <noreply@anthropic.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n```\n")).toEqual([]);
    expect(pull("~~~text\nAssisted-by: Claude Code\n~~~")).toEqual([]);
    const c = cls.commit({ sha: "a", date: "", url: "u", parents: 1, message: "docs: trailer format\n\n```\nCo-Authored-By: Claude <noreply@anthropic.com>\n```" });
    expect(c).toEqual([]);
  });
  it("still counts a real footer after a code block", () => {
    expect(pull("Example:\n```js\nx()\n```\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)").map((m) => m.agentId)).toEqual(["claude-code"]);
  });
  it("treats an unclosed fence as code until the end", () => {
    expect(pull("```\nCo-authored-by: Claude <noreply@anthropic.com>")).toEqual([]);
  });
});
