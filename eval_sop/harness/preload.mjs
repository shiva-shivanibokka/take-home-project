// Preloaded with `node --import ./eval_sop/harness/preload.mjs <stage>/run.mjs --job <id>`.
// 1. Redirects @supabase/supabase-js to a local JSON-file mock (no hosted DB writes).
// 2. Intercepts fetch():
//    - api.tavily.com/search -> served from a cached DuckDuckGo search result file
//      (no Tavily key was available; see RESULTS.md "Deviations").
//    - <OLLAMA_BASE_URL>/v1/chat/completions on localhost -> forwarded to Ollama's
//      native /api/chat so we can pin `seed` and `num_ctx` (OpenAI-compat endpoint
//      cannot set num_ctx). Sent with node:http (no client timeout) because the
//      shared local GPU queue can exceed undici's 300 s header timeout.
//    - api.groq.com chat completions -> adds the Groq key (read in-process from
//      $EVAL_KEY_FILE, never printed), `seed`, and a reasoning setting: gpt-oss
//      models get reasoning_effort "low" (otherwise hidden reasoning consumes the
//      stage's small max_tokens and content comes back empty); qwen3 models get
//      reasoning_effort "none".
//    Every LLM call is appended to $EVAL_LLM_LOG (raw request + response).
import { register } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

register("./hooks.mjs", import.meta.url);

const realFetch = globalThis.fetch;
const SEED = Number(process.env.EVAL_SEED ?? 0);
const NUM_CTX = Number(process.env.EVAL_NUM_CTX ?? 8192);

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function logCall(rec) {
  if (process.env.EVAL_LLM_LOG) {
    fs.appendFileSync(process.env.EVAL_LLM_LOG, JSON.stringify({
      stage: process.env.EVAL_STAGE, job: process.env.EVAL_JOB, seed: SEED, ...rec,
    }) + "\n");
  }
}

function postNoTimeout(url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, text: b }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

function groqKey() {
  const f = process.env.EVAL_KEY_FILE;
  if (!f) return "";
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("OLLAMA_API_KEY="));
  return line ? line.slice("OLLAMA_API_KEY=".length).split(" #")[0].trim() : "";
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.tavily.com/search")) {
    const body = JSON.parse(init.body);
    const key = crypto.createHash("sha1").update(body.query).digest("hex").slice(0, 16);
    const f = path.join(process.env.EVAL_SEARCH_DIR, `${key}.json`);
    if (!fs.existsSync(f)) return jsonResponse({ error: "no cached search" }, 500);
    const cached = JSON.parse(fs.readFileSync(f, "utf8"));
    return jsonResponse({
      results: cached.results.slice(0, body.max_results ?? 10).map((r) => ({
        title: r.title, url: r.href, content: r.body, published_date: "",
      })),
    });
  }
  if (/^http:\/\/(localhost|127\.0\.0\.1):11434\/v1\/chat\/completions/.test(u)) {
    const body = JSON.parse(init.body);
    const t0 = Date.now();
    const res = await postNoTimeout("http://127.0.0.1:11434/api/chat", {
      model: body.model,
      messages: body.messages,
      stream: false,
      keep_alive: "3h",
      options: {
        temperature: body.temperature,
        num_predict: body.max_tokens,
        seed: SEED,
        num_ctx: NUM_CTX,
      },
    });
    if (res.status !== 200) return jsonResponse({ error: res.text }, res.status);
    const j = JSON.parse(res.text);
    const content = j.message?.content ?? "";
    const usage = { prompt_tokens: j.prompt_eval_count ?? 0, completion_tokens: j.eval_count ?? 0 };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    logCall({ provider: "ollama", num_ctx: NUM_CTX, model: body.model, temperature: body.temperature,
      max_tokens: body.max_tokens, messages: body.messages, content, usage, done_reason: j.done_reason, ms: Date.now() - t0 });
    return jsonResponse({ choices: [{ message: { role: "assistant", content } }], usage });
  }
  if (u.startsWith("https://api.groq.com/openai/v1/chat/completions")) {
    const body = JSON.parse(init.body);
    body.seed = SEED;
    if (/gpt-oss/.test(body.model)) body.reasoning_effort = "low";
    else if (/qwen3/.test(body.model)) body.reasoning_effort = "none";
    const t0 = Date.now();
    const res = await realFetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey()}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let content = null, usage = null;
    try { const j = JSON.parse(text); content = j.choices?.[0]?.message?.content ?? null; usage = j.usage ?? null; } catch {}
    logCall({ provider: "groq", model: body.model, temperature: body.temperature, max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort, messages: body.messages, status: res.status,
      content, usage, error: res.ok ? undefined : text.slice(0, 400), ms: Date.now() - t0 });
    return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};
