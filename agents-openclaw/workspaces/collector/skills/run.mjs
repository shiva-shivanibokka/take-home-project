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
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12);
  return items.map((m) => {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      ?? block.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1]
      ?? block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? "";
    // Extract source name from <source> tag if present
    const sourceName = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] ?? "Google News";
    const snippet = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
      ?.replace(/<[^>]+>/g, "").slice(0, 350) ?? "";
    return { title, url: link, snippet, published: pubDate, source: sourceName };
  }).filter((s) => s.url && s.title);
}

async function fetchHackerNews(topic) {
  const q = encodeURIComponent(topic);
  const url = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=8`;
  const json = JSON.parse(await fetchUrl(url));
  return (json.hits ?? []).map((h) => ({
    title: h.title,
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: h.story_text?.replace(/<[^>]+>/g, "").slice(0, 350) ?? "",
    published: h.created_at,
    source: "Hacker News",
  })).filter((s) => s.url && s.title);
}

function dedupByDomain(items) {
  const seen = new Set();
  return items.filter((s) => {
    try {
      const domain = new URL(s.url).hostname.replace(/^www\./, "");
      if (seen.has(domain)) return false;
      seen.add(domain);
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

  // 2. Fetch sources
  const [newsItems, hnItems] = await Promise.allSettled([
    fetchGoogleNewsRSS(job.topic),
    fetchHackerNews(job.topic),
  ]);

  const combined = [
    ...(newsItems.status === "fulfilled" ? newsItems.value : []),
    ...(hnItems.status === "fulfilled" ? hnItems.value : []),
  ];

  // Deduplicate by domain and cap candidates
  const raw = dedupByDomain(combined).slice(0, 15);

  if (!raw.length) throw new Error("No sources fetched from either API");

  // 3. Ask Ollama to score relevance and pick the best 7
  // Use short snippets for LLM scoring to keep token count low (full snippets stored below)
  const sourceList = raw.map((s, i) =>
    `[${i}] ${s.title} (${s.source})${s.snippet ? " — " + s.snippet.slice(0, 120) : ""}`
  ).join("\n");

  const { content: scoredText, tokensUsed } = await ollamaChat([
    {
      role: "system",
      content:
        "You are the Collector agent. Select the 7 most relevant and diverse sources for the topic. " +
        "Respond ONLY with a JSON array of 0-based indices, e.g. [0,2,4,6,9,11,13]. No other text.",
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
    // Fallback: take first 7
    selectedIndices = Array.from({ length: Math.min(7, raw.length) }, (_, i) => i);
  }

  const sources = selectedIndices
    .filter((i) => i >= 0 && i < raw.length)
    .slice(0, 7)
    .map((i) => raw[i]);

  // 4. Write handoff record (idempotent upsert keyed by job_id + from_stage)
  const artifact = {
    sources,
    count: sources.length,
    notes: `Fetched ${combined.length} candidates; deduped to ${raw.length}; selected ${sources.length} for Writer.`,
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
