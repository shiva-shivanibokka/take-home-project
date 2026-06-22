/**
 * Collector agent skill — run.mjs
 *
 * Persona (see SOUL.md): You are the Collector. Your sole job is gathering
 * high-quality, recent sources for a research topic. You do NOT write prose.
 *
 * Input:  job row from Supabase (job_id passed as --job CLI arg)
 * Output: handoffs row with artifact:
 *   { sources:[{title,url,snippet,published}], count, notes, tokens_used }
 *
 * Sources: Google News RSS + Hacker News Algolia search API (both free, no key).
 * LLM:     Ollama Cloud — used to score source relevance + extract snippets.
 *
 * Exit 0 on success, non-zero on any unrecoverable error (orchestrator retries).
 */

import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";
import https from "node:https";

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

// ── Ollama Cloud ─────────────────────────────────────────────────────────────
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "https://api.ollama.ai";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

async function ollamaChat(messages, maxTokens = 512) {
  // Retry up to 4 times with exponential backoff on 429/503
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
        console.error(`[collector] Ollama throttled (${res.status}), retrying in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

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

// ── Source fetching ──────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchGoogleNewsRSS(topic) {
  const q = encodeURIComponent(topic);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchUrl(url);
  // Naive XML parse — good enough for RSS
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
  return items.map((m) => {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      ?? block.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1]
      ?? block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? "";
    const snippet = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
      ?.replace(/<[^>]+>/g, "").slice(0, 200) ?? "";
    return { title, url: link, snippet, published: pubDate, source: "google-news" };
  }).filter((s) => s.url);
}

async function fetchHackerNews(topic) {
  const q = encodeURIComponent(topic);
  const url = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=5`;
  const json = JSON.parse(await fetchUrl(url));
  return (json.hits ?? []).map((h) => ({
    title: h.title,
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: h.story_text?.replace(/<[^>]+>/g, "").slice(0, 200) ?? "",
    published: h.created_at,
    source: "hacker-news",
  })).filter((s) => s.url);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Load job
  const { data: job, error: jobErr } = await db
    .from("jobs").select("*").eq("id", jobId).single();
  if (jobErr || !job) throw new Error(`Job not found: ${jobId}`);

  console.log(`[collector] processing job "${job.topic}"`);

  // 2. Fetch sources
  const [newsItems, hnItems] = await Promise.allSettled([
    fetchGoogleNewsRSS(job.topic),
    fetchHackerNews(job.topic),
  ]);

  const raw = [
    ...(newsItems.status === "fulfilled" ? newsItems.value : []),
    ...(hnItems.status === "fulfilled" ? hnItems.value : []),
  ].slice(0, 10);

  if (!raw.length) throw new Error("No sources fetched from either API");

  // 3. Ask Ollama to score relevance and pick the best 5
  const sourceList = raw.map((s, i) =>
    `[${i}] title: ${s.title}\n    url: ${s.url}\n    snippet: ${s.snippet}`
  ).join("\n\n");

  const { content: scoredText, tokensUsed } = await ollamaChat([
    {
      role: "system",
      content:
        "You are the Collector agent. Given a research topic and a list of candidate sources, " +
        "select the 5 most relevant, recent, and credible ones. " +
        "Respond ONLY with a JSON array of selected indices (0-based), e.g. [0,2,4,6,9]. " +
        "No other text.",
    },
    {
      role: "user",
      content: `Topic: "${job.topic}"\n\nSources:\n${sourceList}`,
    },
  ], 64);

  let selectedIndices;
  try {
    selectedIndices = JSON.parse(scoredText.trim());
    if (!Array.isArray(selectedIndices)) throw new Error();
  } catch {
    // Fallback: take first 5
    selectedIndices = [0, 1, 2, 3, 4].filter((i) => i < raw.length);
  }

  const sources = selectedIndices
    .filter((i) => i >= 0 && i < raw.length)
    .map((i) => raw[i])
    .slice(0, 5);

  // 4. Write handoff record (idempotent upsert keyed by job_id + from_stage)
  const artifact = {
    sources,
    count: sources.length,
    notes: `Fetched ${raw.length} candidates; selected ${sources.length} for Writer.`,
    tokens_used: tokensUsed,
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

  // Signal token usage to orchestrator (parsed from stdout)
  console.log(`tokens:${tokensUsed}`);
  console.log(`[collector] done — ${sources.length} sources written for job ${jobId}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("[collector] fatal:", err.message ?? err);
  process.exit(1);
});
