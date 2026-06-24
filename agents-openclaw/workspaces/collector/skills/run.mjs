/**
 * Collector agent skill — run.mjs
 *
 * Persona (see SOUL.md): You are the Collector. Your sole job is gathering
 * high-quality, recent sources for a research topic. You do NOT write prose.
 *
 * Input:  job row from Supabase (job_id passed as --job CLI arg)
 * Output: handoffs row with artifact:
 *   { sources:[{title,url,snippet,published,source}], count, notes, tokens_used }
 *
 * Sources: Tavily web search API (free tier, 1000 searches/month).
 * LLM:     Groq — used to score source relevance and pick the best 7.
 *
 * Exit 0 on success, non-zero on any unrecoverable error (orchestrator retries).
 */

import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { job: { type: "string" } },
});
const jobId = values.job;
if (!jobId) { console.error("--job required"); process.exit(1); }

// ── Supabase (service role from env) ────────────────────────────────────────
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── LLM (Groq / Ollama-compatible) ──────────────────────────────────────────
const OLLAMA_BASE  = process.env.OLLAMA_BASE_URL ?? "https://api.groq.com/openai";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL    ?? "llama-3.1-8b-instant";
console.log(`[collector] using model: ${OLLAMA_MODEL}`);

async function ollamaChat(messages, maxTokens = 512) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.OLLAMA_API_KEY
            ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
      });

      if (res.status === 429 || res.status === 503) {
        const wait = 2 ** attempt * 4_000 + Math.random() * 2_000;
        console.error(`[collector] LLM throttled (${res.status}), retrying in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);

      const json = await res.json();
      return {
        content: json.choices[0].message.content,
        tokensUsed: json.usage?.total_tokens ?? 0,
      };
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2 ** attempt * 3_000);
    }
  }
}

// ── Tavily web search ─────────────────────────────────────────────────────────
async function fetchTavily(topic) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      api_key: apiKey,
      query: topic,
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
    }),
  });

  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const json = await res.json();

  return (json.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content ?? "").slice(0, 350),
    published: r.published_date ?? "",
    source: (() => {
      try { return new URL(r.url).hostname.replace(/^www\./, ""); }
      catch { return r.url; }
    })(),
  })).filter((s) => s.url && s.title);
}

function dedupByDomain(items) {
  const seen = new Set();
  return items.filter((s) => {
    try {
      const key = new URL(s.url).hostname.replace(/^www\./, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch { return true; }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Load job
  const { data: job, error: jobErr } = await db
    .from("jobs").select("*").eq("id", jobId).single();
  if (jobErr || !job) throw new Error(`Job not found: ${jobId}`);

  console.log(`[collector] processing job "${job.topic}"`);

  // 2. Fetch sources via Tavily
  const items = await fetchTavily(job.topic);
  console.log(`[collector] Tavily returned ${items.length} results`);

  // Deduplicate by domain
  const raw = dedupByDomain(items);

  if (!raw.length) throw new Error("No sources returned by Tavily");

  // 3. Ask LLM to score relevance and pick the best 7
  const sourceList = raw.map((s, i) =>
    `[${i}] ${s.title} (${s.source})${s.snippet ? " — " + s.snippet.slice(0, 120) : ""}`
  ).join("\n");

  const { content: scoredText, tokensUsed } = await ollamaChat([
    {
      role: "system",
      content:
        "You are the Collector agent. Select the 7 most relevant and diverse sources for the topic. " +
        "Respond ONLY with a JSON array of 0-based indices, e.g. [0,2,4,6,9]. No other text.",
    },
    {
      role: "user",
      content: `Topic: "${job.topic}"\n\n${sourceList}`,
    },
  ], 128);

  let selectedIndices;
  try {
    const match = scoredText.match(/\[[\d,\s]+\]/);
    selectedIndices = JSON.parse(match ? match[0] : scoredText.trim());
    if (!Array.isArray(selectedIndices)) throw new Error();
  } catch {
    selectedIndices = Array.from({ length: Math.min(7, raw.length) }, (_, i) => i);
  }

  let sources = selectedIndices
    .filter((i) => i >= 0 && i < raw.length)
    .slice(0, 7)
    .map((i) => raw[i]);

  if (sources.length === 0) sources = raw.slice(0, 7);

  // 4. Write handoff record (idempotent upsert keyed by job_id + from_stage)
  const artifact = {
    sources,
    count: sources.length,
    notes: `Tavily returned ${items.length} results; deduped to ${raw.length}; selected ${sources.length} for Writer.`,
    tokens_used: tokensUsed,
    model: OLLAMA_MODEL,
  };

  const { error: upsertErr } = await db.from("handoffs").upsert(
    {
      job_id: jobId,
      from_stage: "collecting",
      to_stage: "writing",
      agent_id: "collector",
      artifact,
      tokens_used: tokensUsed,
    },
    { onConflict: "job_id,from_stage" }
  );
  if (upsertErr) throw new Error(`Handoff upsert failed: ${upsertErr.message}`);

  console.log(`tokens:${tokensUsed}`);
  console.log(`[collector] done — ${sources.length} sources written for job ${jobId}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("[collector] fatal:", err.message ?? err);
  process.exit(1);
});
