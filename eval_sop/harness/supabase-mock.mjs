// Local stand-in for @supabase/supabase-js used ONLY by the eval harness.
// Implements the tiny subset of the query-builder API that the three stage
// scripts call, backed by one JSON file per job in $EVAL_DB_DIR.
// No network access, never touches the hosted database.
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.EVAL_DB_DIR;
if (!DIR) throw new Error("EVAL_DB_DIR not set (eval harness)");

function load(jobId) {
  const f = path.join(DIR, `${jobId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function save(jobId, doc) {
  fs.writeFileSync(path.join(DIR, `${jobId}.json`), JSON.stringify(doc, null, 2));
}
function jobIdOf(table, filters, row) {
  if (table === "jobs") return filters.id ?? row?.id;
  return filters.job_id ?? row?.job_id;
}
function rowsOf(doc, table) {
  if (!doc) return [];
  if (table === "jobs") return [doc.job];
  if (table === "handoffs") return Object.values(doc.handoffs ?? {});
  return doc[table] ?? [];
}

class Q {
  constructor(table) { this.table = table; this.filters = {}; this.op = "select"; this.mode = "many"; }
  select() { return this; }
  eq(k, v) { this.filters[k] = v; return this; }
  order() { return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  upsert(row) { this.op = "upsert"; this.row = row; return this; }
  insert(row) { this.op = "insert"; this.row = row; return this; }
  update(patch) { this.op = "update"; this.patch = patch; return this; }
  run() {
    const jid = jobIdOf(this.table, this.filters, this.row);
    const doc = load(jid);
    if (this.op === "select") {
      let rows = rowsOf(doc, this.table).filter((r) =>
        Object.entries(this.filters).every(([k, v]) => r?.[k] === v));
      if (this.lim) rows = rows.slice(0, this.lim);
      if (this.mode === "single")
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
      if (this.mode === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    if (!doc) return { data: null, error: { message: `no job ${jid}` } };
    if (this.op === "upsert" && this.table === "handoffs") {
      doc.handoffs = doc.handoffs ?? {};
      doc.handoffs[this.row.from_stage] = { ...this.row, created_at: new Date().toISOString() };
    } else if (this.op === "insert") {
      (doc[this.table] = doc[this.table] ?? []).push({ ...this.row, created_at: new Date().toISOString() });
    } else if (this.op === "update" && this.table === "jobs") {
      Object.assign(doc.job, this.patch);
    } else {
      return { data: null, error: { message: `mock: unsupported ${this.op} on ${this.table}` } };
    }
    save(jid, doc);
    return { data: null, error: null };
  }
  then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
}

export function createClient() {
  return { from: (t) => new Q(t) };
}
