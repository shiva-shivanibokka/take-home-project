// Runs the UNMODIFIED stage scripts (agents-openclaw/workspaces/*/skills/run.mjs)
// exactly as the orchestrator does (`node run.mjs --job <id>`), but with the
// eval harness preloaded (local JSON DB, cached search, local Ollama with seeds).
//
//   node eval_sop/run_pipeline.mjs gen    --base groq --cmodel openai/gpt-oss-20b --wmodel qwen/qwen3.8-27b --seed 0
//   node eval_sop/run_pipeline.mjs review --base ollama --model qwen2.5:7b --seed 0 --snip 150 [--wseed 0]
// Questions are processed in an interleaved order (simpleqa, popqa_high, simpleqa, popqa_low, ...)
// so that a run truncated by free-tier quotas still covers all strata.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WS = path.join(ROOT, "agents-openclaw", "workspaces");
// Each run lives in eval_sop/runs/$EVAL_RUN (default "local"); the search cache is shared.
const DATA = path.join(HERE, "runs", process.env.EVAL_RUN ?? "local");
const SEARCH = path.join(HERE, "data", "search");
const QFILE = path.join(HERE, process.env.EVAL_QUESTIONS ?? "questions.json");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "qwen2.5:7b" },
    base: { type: "string", default: "ollama" },
    cmodel: { type: "string", default: "openai/gpt-oss-20b" },
    wmodel: { type: "string", default: "qwen/qwen3.8-27b" },
    limit: { type: "string", default: "1000" },
    pace: { type: "string", default: "0" }, // ms pause between jobs (free-tier tokens/minute)
    seed: { type: "string", default: "0" },
    wseed: { type: "string", default: "0" },
    snip: { type: "string", default: "150" },
    only: { type: "string" },
  },
});
const phase = positionals[0];
const allQ = JSON.parse(fs.readFileSync(QFILE, "utf8"));
const byStratum = {};
for (const q of allQ) (byStratum[q.stratum] ??= []).push(q);
const known = ["simpleqa", "popqa_high", "popqa_low"];
const pattern = Object.keys(byStratum).every((k) => known.includes(k))
  ? ["simpleqa", "popqa_high", "simpleqa", "popqa_low"]   // 2:1:1, as in questions.json
  : Object.keys(byStratum);                                // other sets: plain round-robin
const ordered = [];
for (let k = 0; ordered.length < allQ.length && k <= 4 * allQ.length; k++) {
  const q = byStratum[pattern[k % pattern.length]]?.shift();
  if (q) ordered.push(q);
}
const topics = ordered.slice(0, Number(values.limit))
  .map((q) => ({ id: q.id, topic: q.question }))
  .filter((t) => !values.only || values.only.split(",").includes(t.id));
const DB = path.join(DATA, "db"); fs.mkdirSync(DB, { recursive: true });
fs.mkdirSync(path.join(DATA, "llm_logs"), { recursive: true });
fs.mkdirSync(path.join(DATA, "reviews"), { recursive: true });

const BASE = values.base === "groq" ? "https://api.groq.com/openai" : "http://localhost:11434";

function runStage(stage, jobId, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(HERE, "harness", "preload.mjs")).href,
    path.join(WS, stage, "skills", "run.mjs"), "--job", jobId,
  ], {
    encoding: "utf8",
    env: {
      ...process.env, // NOTE: no .env is loaded; no hosted credentials reach the stages
      SUPABASE_URL: "http://mock.invalid", SUPABASE_SERVICE_ROLE_KEY: "mock",
      OLLAMA_BASE_URL: BASE, OLLAMA_API_KEY: "",
      EVAL_KEY_FILE: process.env.EVAL_KEY_FILE ?? "", // only needed for --base groq
      TAVILY_API_KEY: "cached-ddgs", EVAL_DB_DIR: DB,
      EVAL_SEARCH_DIR: SEARCH,
      EVAL_STAGE: stage, EVAL_JOB: jobId, ...env,
    },
  });
  return { stage, status: r.status, ms: Date.now() - t0, stdout: r.stdout, stderr: r.stderr };
}

let consecutiveFails = 0;
if (phase === "list") {
  console.log(topics.map((t) => t.id).join(","));
} else if (phase === "gen") {
  const log = path.join(DATA, "llm_logs", `gen_w${values.seed}.jsonl`);
  const runlog = path.join(DATA, `gen_w${values.seed}_runs.jsonl`);
  for (const t of topics) {
    const jobId = `${t.id}_w${values.seed}`;
    const f = path.join(DB, `${jobId}.json`);
    if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).handoffs?.writing) continue;
    fs.writeFileSync(f, JSON.stringify({ job: { id: jobId, topic: t.topic, status: "collecting" }, handoffs: {} }, null, 2));
    const env = { OLLAMA_MODEL: values.cmodel, WRITER_MODEL: values.wmodel, EVAL_SEED: values.seed, EVAL_LLM_LOG: log };
    let failed = false;
    for (const stage of ["collector", "writer"]) {
      const r = runStage(stage, jobId, env);
      fs.appendFileSync(runlog, JSON.stringify({ jobId, ...r }) + "\n");
      console.log(jobId, stage, r.status, `${(r.ms / 1000).toFixed(1)}s`);
      if (r.status !== 0) { console.log(r.stderr.slice(-400)); failed = true; break; }
    }
    consecutiveFails = failed ? consecutiveFails + 1 : 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(values.pace));
    if (consecutiveFails >= 3) { console.log("3 consecutive failures (quota?) - stopping"); break; }
  }
} else if (phase === "review") {
  const cond = `rev_${values.model.replace(/[:./]/g, "-")}_snip${values.snip}_s${values.seed}_w${values.wseed}`;
  const out = path.join(DATA, "reviews", `${cond}.jsonl`);
  const done = new Set(fs.existsSync(out)
    ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).jobId) : []);
  for (const t of topics) {
    const jobId = `${t.id}_w${values.wseed}`;
    if (done.has(jobId)) continue;
    const r = runStage("reviewer", jobId, {
      OLLAMA_MODEL: values.model, EVAL_SEED: values.seed, REVIEWER_SNIPPET_CHARS: values.snip,
      EVAL_LLM_LOG: path.join(DATA, "llm_logs", `${cond}.jsonl`),
    });
    const doc = JSON.parse(fs.readFileSync(path.join(DB, `${jobId}.json`), "utf8"));
    const review = r.status === 0 ? doc.handoffs.review?.artifact ?? null : null;
    if (doc.handoffs.review) delete doc.handoffs.review; // keep DB clean between conditions
    doc.job.status = "review";
    fs.writeFileSync(path.join(DB, `${jobId}.json`), JSON.stringify(doc, null, 2));
    fs.appendFileSync(out, JSON.stringify({
      jobId, cond, model: values.model, seed: Number(values.seed), snip: Number(values.snip),
      exit: r.status, ms: r.ms, review, stderr: r.stderr.slice(-600),
    }) + "\n");
    console.log(cond, jobId, r.status, review ? `conf=${review.confidence} ${review.verdict}` : "FAIL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(values.pace));
  }
} else {
  console.error("usage: run_pipeline.mjs list|gen|review [--model m] [--seed s] [--snip n] [--wseed s]");
  process.exit(2);
}
