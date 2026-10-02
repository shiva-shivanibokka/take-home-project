// Runs the UNMODIFIED stage scripts (agents-openclaw/workspaces/*/skills/run.mjs)
// exactly as the orchestrator does (`node run.mjs --job <id>`), but with the
// eval harness preloaded (local JSON DB, cached search, local Ollama with seeds).
//
//   node eval_sop/run_pipeline.mjs gen    --model llama3.1:8b --seed 0
//   node eval_sop/run_pipeline.mjs review --model llama3.1:8b --seed 0 --snip 150 [--wseed 0]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WS = path.join(ROOT, "agents-openclaw", "workspaces");
const DATA = path.join(HERE, "data");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "llama3.1:8b" },
    seed: { type: "string", default: "0" },
    wseed: { type: "string", default: "0" },
    snip: { type: "string", default: "150" },
    only: { type: "string" },
  },
});
const phase = positionals[0];
const topics = JSON.parse(fs.readFileSync(path.join(HERE, "questions.json"), "utf8"))
  .map((q) => ({ id: q.id, topic: q.question }))
  .filter((t) => !values.only || values.only.split(",").includes(t.id));
const DB = path.join(DATA, "db"); fs.mkdirSync(DB, { recursive: true });
fs.mkdirSync(path.join(DATA, "llm_logs"), { recursive: true });
fs.mkdirSync(path.join(DATA, "reviews"), { recursive: true });

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
      OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_API_KEY: "",
      TAVILY_API_KEY: "cached-ddgs", EVAL_DB_DIR: DB,
      EVAL_SEARCH_DIR: path.join(DATA, "search"),
      EVAL_STAGE: stage, EVAL_JOB: jobId, ...env,
    },
  });
  return { stage, status: r.status, ms: Date.now() - t0, stdout: r.stdout, stderr: r.stderr };
}

if (phase === "gen") {
  const log = path.join(DATA, "llm_logs", `gen_w${values.seed}.jsonl`);
  const runlog = path.join(DATA, `gen_w${values.seed}_runs.jsonl`);
  for (const t of topics) {
    const jobId = `${t.id}_w${values.seed}`;
    const f = path.join(DB, `${jobId}.json`);
    if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).handoffs?.writing) continue;
    fs.writeFileSync(f, JSON.stringify({ job: { id: jobId, topic: t.topic, status: "collecting" }, handoffs: {} }, null, 2));
    const env = { OLLAMA_MODEL: values.model, EVAL_SEED: values.seed, EVAL_LLM_LOG: log };
    for (const stage of ["collector", "writer"]) {
      const r = runStage(stage, jobId, env);
      fs.appendFileSync(runlog, JSON.stringify({ jobId, ...r }) + "\n");
      console.log(jobId, stage, r.status, `${(r.ms / 1000).toFixed(1)}s`);
      if (r.status !== 0) { console.log(r.stderr.slice(-400)); break; }
    }
  }
} else if (phase === "review") {
  const cond = `rev_${values.model.replace(/[:.]/g, "-")}_snip${values.snip}_s${values.seed}_w${values.wseed}`;
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
  }
} else {
  console.error("usage: run_pipeline.mjs gen|review [--model m] [--seed s] [--snip n] [--wseed s]");
  process.exit(2);
}
