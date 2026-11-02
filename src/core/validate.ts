import type { Board, BoardEntry } from "./dataset";
import { REPORT_SCHEMA, type Evidence, type Report, type Section } from "./types";

/** Result of a validation: the value if it is valid, otherwise the problems found. */
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const GH_URL = /^https:\/\/github\.com\//;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

function counts(map: unknown, path: string, errors: string[]): number {
  if (!isObj(map)) {
    errors.push(`${path} is not an object`);
    return 0;
  }
  let sum = 0;
  for (const [k, v] of Object.entries(map)) {
    if (!/^[a-z0-9-]+$/.test(k)) errors.push(`${path} has a bad agent id ${JSON.stringify(k)}`);
    if (!isCount(v)) errors.push(`${path}.${k} is not a count`);
    else sum += v;
  }
  return sum;
}

function checkEvidence(ev: unknown, path: string, errors: string[]) {
  if (!Array.isArray(ev)) return errors.push(`${path} is not a list`);
  ev.forEach((e: unknown, i) => {
    if (!isObj(e)) return errors.push(`${path}[${i}] is not an object`);
    const x = e as Partial<Evidence>;
    if (typeof x.url !== "string" || !GH_URL.test(x.url)) errors.push(`${path}[${i}].url is not a github.com link`);
    for (const f of ["agentId", "kind", "ref", "title", "matched"] as const) if (typeof x[f] !== "string") errors.push(`${path}[${i}].${f} missing`);
  });
}

function checkSection(s: unknown, path: string, errors: string[]) {
  if (!isObj(s)) return errors.push(`${path} missing`);
  const x = s as Partial<Section>;
  for (const f of ["fetched", "total", "ai", "hints"] as const) if (!isCount(x[f])) errors.push(`${path}.${f} is not a count`);
  if (isCount(x.total) && isCount(x.ai) && x.ai > x.total) errors.push(`${path}.ai is larger than total`);
  if (isCount(x.total) && isCount(x.fetched) && x.total > x.fetched) errors.push(`${path}.total is larger than fetched`);
  if (isCount(x.ai) && counts(x.byAgent, `${path}.byAgent`, errors) !== x.ai) errors.push(`${path}.byAgent does not add up to ai`);
  if (isCount(x.hints) && counts(x.hintsByAgent, `${path}.hintsByAgent`, errors) !== x.hints) errors.push(`${path}.hintsByAgent does not add up to hints`);
  if (typeof x.capped !== "boolean") errors.push(`${path}.capped is not a boolean`);
  if (x.oldest !== null && !isDate(x.oldest)) errors.push(`${path}.oldest is not a date`);
  if (!Array.isArray(x.byMonth)) errors.push(`${path}.byMonth is not a list`);
  else {
    let total = 0;
    let ai = 0;
    for (const m of x.byMonth) {
      if (!isObj(m) || typeof m.month !== "string" || !/^\d{4}-\d{2}$/.test(m.month) || !isCount(m.total) || !isCount(m.ai)) {
        errors.push(`${path}.byMonth has a bad entry`);
        continue;
      }
      if (counts(m.byAgent, `${path}.byMonth[${m.month}].byAgent`, errors) !== m.ai) errors.push(`${path}.byMonth[${m.month}].byAgent does not add up`);
      total += m.total as number;
      ai += m.ai as number;
    }
    if (isCount(x.total) && total !== x.total) errors.push(`${path}.byMonth totals do not add up`);
    if (isCount(x.ai) && ai !== x.ai) errors.push(`${path}.byMonth AI counts do not add up`);
  }
  checkEvidence(x.evidence, `${path}.evidence`, errors);
}

const isShare = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function checkRange(x: unknown, path: string, errors: string[]) {
  if (!isObj(x) || !isShare(x.point) || !isShare(x.lo) || !isShare(x.hi)) return errors.push(`${path} is not a share range`);
  if (!((x.lo as number) <= (x.point as number) + 1e-9 && (x.point as number) <= (x.hi as number) + 1e-9)) errors.push(`${path} is not ordered lo ≤ point ≤ hi`);
}
function checkBeyond(b: unknown, errors: string[]) {
  if (!isObj(b)) return errors.push("beyond is not an object");
  if (b.setup !== null && !(Array.isArray(b.setup) && b.setup.every((s: any) => isObj(s) && typeof s.path === "string" && typeof s.agentId === "string"))) errors.push("beyond.setup is invalid");
  const a = b.authors as Record<string, unknown> | undefined;
  if (!isObj(a) || !isCount(a.aiAuthors) || !isCount(a.authors) || !isCount(a.commitsByAiAuthors) || (a.aiAuthors as number) > (a.authors as number)) errors.push("beyond.authors is invalid");
  if (b.estimate !== null) {
    checkRange(b.estimate, "beyond.estimate", errors);
    const e = b.estimate as Record<string, unknown>;
    if (isObj(e) && (!["disclosed", "setup"].includes(e.gate as string) || !isCount(e.tooShort))) errors.push("beyond.estimate fields are invalid");
  }
  if (b.likely !== null) checkRange(b.likely, "beyond.likely", errors);
}

export function validateReport(v: unknown): Checked<Report> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["not an object"] };
  const r = v as Partial<Report>;
  if (r.schema !== REPORT_SCHEMA) errors.push(`schema ${String(r.schema)} is not ${REPORT_SCHEMA}`);
  if (!isObj(r.repo) || typeof r.repo.fullName !== "string" || !REPO.test(r.repo.fullName)) errors.push("repo.fullName is not owner/repo");
  else {
    if (typeof r.repo.url !== "string" || !GH_URL.test(r.repo.url)) errors.push("repo.url is not a github.com link");
    if (!isCount(r.repo.stars)) errors.push("repo.stars is not a count");
  }
  if (!isObj(r.window) || !isDate(r.window.since) || !isDate(r.window.until) || !isCount(r.window.days)) errors.push("window is invalid");
  else if (Date.parse(r.window.since) > Date.parse(r.window.until)) errors.push("window starts after it ends");
  if (!isDate(r.generatedAt)) errors.push("generatedAt is not a date");
  else if (Date.parse(r.generatedAt) > Date.now() + 3_600_000) errors.push("generatedAt is in the future");
  checkSection(r.commits, "commits", errors);
  checkSection(r.pulls, "pulls", errors);
  if (r.beyond !== undefined) checkBeyond(r.beyond, errors);
  if (isObj(r.commits) && isCount(r.commits.total) && isCount(r.commits.ai)) {
    const want = r.commits.total > 0 ? r.commits.ai / r.commits.total : null;
    if (r.share !== want && !(typeof r.share === "number" && want !== null && Math.abs(r.share - want) < 1e-9)) errors.push("share does not match ai/total");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v as unknown as Report };
}

function checkEntry(e: unknown, i: number, errors: string[]) {
  if (!isObj(e)) return errors.push(`repos[${i}] is not an object`);
  const x = e as Partial<BoardEntry>;
  if (typeof x.fullName !== "string" || !REPO.test(x.fullName)) errors.push(`repos[${i}].fullName is not owner/repo`);
  for (const f of ["stars", "ai", "total", "prAi", "prTotal"] as const) if (!isCount(x[f])) errors.push(`repos[${i}].${f} is not a count`);
  if (isCount(x.ai) && isCount(x.total) && x.ai > x.total) errors.push(`repos[${i}].ai is larger than total`);
  if (isCount(x.ai) && counts(x.byAgent, `repos[${i}].byAgent`, errors) !== x.ai) errors.push(`repos[${i}].byAgent does not add up to ai`);
  if (x.share !== null && (typeof x.share !== "number" || !Number.isFinite(x.share) || x.share < 0 || x.share > 1)) errors.push(`repos[${i}].share is not between 0 and 1`);
  if (x.top !== null && typeof x.top !== "string") errors.push(`repos[${i}].top is not an agent id`);
  if (typeof x.capped !== "boolean") errors.push(`repos[${i}].capped is not a boolean`);
  if (!isDate(x.measuredAt)) errors.push(`repos[${i}].measuredAt is not a date`);
  if (x.cohort !== undefined && x.cohort !== "top" && x.cohort !== "tracked") errors.push(`repos[${i}].cohort is unknown`);
}

export function validateBoard(v: unknown): Checked<Board> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["not an object"] };
  const b = v as Partial<Board>;
  if (b.schema !== 1) errors.push("schema is not 1");
  if (!isDate(b.generatedAt)) errors.push("generatedAt is not a date");
  if (!isCount(b.days)) errors.push("days is not a count");
  if (!Array.isArray(b.repos)) errors.push("repos is not a list");
  else b.repos.forEach((e, i) => checkEntry(e, i, errors));
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, value: v as unknown as Board };
}

/** Checks the shape of raw crawler data before it is reclassified. */
export function validateRepoData(v: unknown): Checked<unknown> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["not an object"] };
  const d = v as Record<string, any>;
  if (!isObj(d.repo) || typeof d.repo.fullName !== "string" || !REPO.test(d.repo.fullName)) errors.push("repo.fullName is not owner/repo");
  for (const k of ["commits", "pulls"]) if (!isObj(d[k]) || !Array.isArray(d[k].items) || typeof d[k].capped !== "boolean") errors.push(`${k} is invalid`);
  const str = (v: unknown) => typeof v === "string";
  const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
  if (isObj(d.commits) && Array.isArray(d.commits.items))
    d.commits.items.forEach((c: any, i: number) => {
      if (!isObj(c) || !str(c.sha) || !str(c.message) || !str(c.date) || !str(c.url) || typeof c.parents !== "number") return errors.push(`commits.items[${i}] is invalid`);
      for (const f of ["authorName", "authorEmail", "authorLogin", "committerName", "committerEmail", "committerLogin"]) if (!optStr(c[f])) errors.push(`commits.items[${i}].${f} is not text`);
    });
  if (isObj(d.pulls) && Array.isArray(d.pulls.items))
    d.pulls.items.forEach((p: any, i: number) => {
      if (!isObj(p) || typeof p.number !== "number" || !str(p.title) || !str(p.branch) || !str(p.createdAt) || !str(p.url) || !optStr(p.body) || !optStr(p.authorLogin)) errors.push(`pulls.items[${i}] is invalid`);
    });
  if (!isDate(d.since) || !isDate(d.until) || !isCount(d.days)) errors.push("window is invalid");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
