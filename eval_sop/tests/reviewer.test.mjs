// Tests for the reviewer stage, run with:  node --test eval_sop/tests/
// Uses a stub LLM HTTP server (canned responses) and the local JSON DB mock,
// so no model, network or hosted DB is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const REVIEWER = path.join(ROOT, "agents-openclaw", "workspaces", "reviewer", "skills", "run.mjs");
const PRELOAD = pathToFileURL(path.join(ROOT, "eval_sop", "harness", "preload.mjs")).href;

const LONG = "A".repeat(150) + "§".repeat(200); // 350-char snippet; "§" only visible past 150 chars

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revtest-"));
  const doc = {
    job: { id: "j1", topic: "test topic", status: "review" },
    handoffs: {
      collecting: { job_id: "j1", from_stage: "collecting", artifact: { sources: [{ title: "S1", url: "https://x.test", snippet: LONG }] } },
      writing: { job_id: "j1", from_stage: "writing", artifact: { title: "T", brief_markdown: "# T\nbody", citations: ["https://x.test"] } },
    },
  };
  fs.writeFileSync(path.join(dir, "j1.json"), JSON.stringify(doc));
  return dir;
}

// Original reviewer from the commit this branch forked from (417589b), for equivalence checks.
import { execFileSync } from "node:child_process";
const ORIG = path.join(os.tmpdir(), "reviewer_orig_417589b.mjs");
fs.writeFileSync(ORIG, execFileSync("git", ["-C", ROOT, "show", "417589b:agents-openclaw/workspaces/reviewer/skills/run.mjs"]));

async function runWithStub(llmContent, extraEnv = {}, script = REVIEWER) {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      prompts.push(JSON.parse(b).messages[0].content);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: llmContent } }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fixture();
  const env = { ...process.env, EVAL_DB_DIR: dir, SUPABASE_URL: "http://mock.invalid", SUPABASE_SERVICE_ROLE_KEY: "m",
    OLLAMA_BASE_URL: `http://127.0.0.1:${server.address().port}`, OLLAMA_MODEL: "stub", ...extraEnv };
  if (!("REVIEWER_SNIPPET_CHARS" in extraEnv)) delete env.REVIEWER_SNIPPET_CHARS;
  const child = spawn(process.execPath, ["--import", PRELOAD, script, "--job", "j1"], { env });
  let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "j1.json"), "utf8"));
  return { code, stderr, prompts, review: doc.handoffs.review?.artifact };
}

const OK = JSON.stringify({ citations_supported: true, coverage: true, factuality: true, confidence: 0.9, reasons: [] });

test("snippet hook: default prompt is identical to explicit 150 (original behaviour preserved)", async () => {
  const a = await runWithStub(OK);
  const b = await runWithStub(OK, { REVIEWER_SNIPPET_CHARS: "150" });
  assert.equal(a.code, 0); assert.equal(b.code, 0);
  assert.equal(a.prompts[0], b.prompts[0]);
  assert.ok(a.prompts[0].includes("A".repeat(150)));
  assert.ok(!a.prompts[0].includes("§"), "reviewer must only see 150 chars by default");
});

test("snippet hook: default prompt is byte-identical to the original 417589b reviewer", async () => {
  const a = await runWithStub(OK);
  const o = await runWithStub(OK, {}, ORIG);
  assert.equal(o.code, 0);
  assert.equal(a.prompts[0], o.prompts[0]);
});

test("snippet hook: 350 exposes the full collector snippet", async () => {
  const c = await runWithStub(OK, { REVIEWER_SNIPPET_CHARS: "350" });
  assert.equal(c.code, 0);
  assert.ok(c.prompts[0].includes(LONG));
});

test("verdict ignores failed checks (anyCheckFailed is dead code) - documents current behaviour", async () => {
  const r = await runWithStub(JSON.stringify({ citations_supported: false, coverage: false, factuality: false, confidence: 0.95, reasons: ["x"] }));
  assert.equal(r.code, 0);
  assert.equal(r.review.verdict, "publish");
});

test("numeric-string confidence from the LLM must not crash the reviewer (coerced to number)", async () => {
  const r = await runWithStub(JSON.stringify({ citations_supported: true, coverage: true, factuality: true, confidence: "0.85", reasons: [] }));
  assert.equal(r.code, 0, `reviewer crashed: ${r.stderr.slice(-200)}`);
  assert.equal(typeof r.review.confidence, "number");
});

test("missing confidence field must not crash the reviewer (should escalate)", async () => {
  const r = await runWithStub(JSON.stringify({ citations_supported: true, coverage: true, factuality: true, reasons: [] }));
  assert.equal(r.code, 0, `reviewer crashed: ${r.stderr.slice(-200)}`);
  assert.equal(r.review.verdict, "escalate");
});

// Fix phase (2026-10-04): coercion edge cases reported by the adversarial review.
test("boolean confidence (true) must not be coerced to 1.0 - treated as non-numeric, escalate", async () => {
  const r = await runWithStub(JSON.stringify({ citations_supported: true, coverage: true, factuality: true, confidence: true, reasons: [] }));
  assert.equal(r.code, 0);
  assert.equal(r.review.confidence, 0);
  assert.equal(r.review.verdict, "escalate");
});

test("REVIEWER_SNIPPET_CHARS='' falls back to the 150-char default (not 0)", async () => {
  const a = await runWithStub(OK, { REVIEWER_SNIPPET_CHARS: "" });
  assert.equal(a.code, 0);
  assert.ok(a.prompts[0].includes("A".repeat(150)), "empty env var must not hide the snippet");
  assert.ok(!a.prompts[0].includes("§"));
});
