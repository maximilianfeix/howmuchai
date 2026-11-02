import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dirs = [".github/workflows", ".github/actions/alert", ".github/ISSUE_TEMPLATE", "."];
const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(d, f)));

describe("workflow and template files", () => {
  for (const f of files) {
    it(`${f} is valid YAML`, () => {
      expect(() => parse(readFileSync(f, "utf8"), { strict: true, uniqueKeys: true })).not.toThrow();
    });
  }
  it("every workflow has a name, triggers and jobs", () => {
    for (const f of files.filter((f) => f.startsWith(".github/workflows"))) {
      const w = parse(readFileSync(f, "utf8"));
      expect(typeof w.name, f).toBe("string");
      expect(w.on, f).toBeTruthy();
      expect(Object.keys(w.jobs ?? {}).length, f).toBeGreaterThan(0);
    }
  });
  it("never interpolates untrusted event text into run scripts", () => {
    for (const f of files.filter((f) => f.startsWith(".github/workflows"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/run:[^\n]*\$\{\{\s*github\.event\.(issue|comment|pull_request)\.(title|body)/);
    }
  });
});
