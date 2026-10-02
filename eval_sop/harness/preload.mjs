// Preloaded with `node --import ./eval_sop/harness/preload.mjs <stage>/run.mjs --job <id>`.
// 1. Redirects @supabase/supabase-js to a local JSON-file mock (no hosted DB writes).
// 2. Intercepts fetch():
//    - api.tavily.com/search -> served from a cached DuckDuckGo search result file
//      (no Tavily key was available; see RESULTS.md "Deviations").
//    - <OLLAMA_BASE_URL>/v1/chat/completions on localhost -> forwarded to Ollama's
//      native /api/chat so we can pin `seed` and `num_ctx` (OpenAI-compat endpoint
//      cannot set num_ctx). Response is converted back to the OpenAI shape the
//      stage code expects. Every call is appended to $EVAL_LLM_LOG (raw I/O).
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

register("./hooks.mjs", import.meta.url);

const realFetch = globalThis.fetch;
const SEED = Number(process.env.EVAL_SEED ?? 0);
const NUM_CTX = Number(process.env.EVAL_NUM_CTX ?? 8192);

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
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
    const res = await realFetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });
    if (!res.ok) return jsonResponse({ error: await res.text() }, res.status);
    const j = await res.json();
    const content = j.message?.content ?? "";
    const usage = { prompt_tokens: j.prompt_eval_count ?? 0, completion_tokens: j.eval_count ?? 0 };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (process.env.EVAL_LLM_LOG) {
      fs.appendFileSync(process.env.EVAL_LLM_LOG, JSON.stringify({
        stage: process.env.EVAL_STAGE, job: process.env.EVAL_JOB, seed: SEED, num_ctx: NUM_CTX,
        model: body.model, temperature: body.temperature, max_tokens: body.max_tokens,
        messages: body.messages, content, usage, done_reason: j.done_reason, ms: Date.now() - t0,
      }) + "\n");
    }
    return jsonResponse({ choices: [{ message: { role: "assistant", content } }], usage });
  }
  return realFetch(url, init);
};
