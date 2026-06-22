/**
 * Writer agent skill — run.mjs
 *
 * Persona (see SOUL.md): You are the Writer. You receive a curated source
 * list from the Collector and draft a well-structured research brief in
 * Markdown. You cite every claim. You do NOT evaluate confidence — that is
 * the Reviewer's job.
 *
 * Input:  handoffs row from "collecting" stage (upstream artifact)
 * Output: handoffs row with artifact:
 *   { title, brief_markdown, citations:[url,...], word_count, tokens_used }
 *
 * LLM: Ollama Cloud (throttle-aware — retries on 429).
 * Exit 0 on success, non-zero on error (orchestrator retries).
 */

import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { job: { type: "string" } },
});
const jobId = values.job;
if (!jobId) { console.error("--job required"); process.exit(1); }

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "https://api.ollama.ai";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

async function ollamaChat(messages, maxTokens = 1400) {
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
          temperature: 0.4,
        }),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = 2 ** attempt * 6_000 + Math.random() * 3_000;
        console.error(`[writer] Ollama throttled (${res.status}), retrying in ${Math.round(wait)}ms`);
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
      await sleep(2 ** attempt * 4_000);
    }
  }
}

async function main() {
  // 1. Load job + collector handoff
  const [{ data: job }, { data: collectorHandoff }] = await Promise.all([
    db.from("jobs").select("*").eq("id", jobId).single(),
    db.from("handoffs")
      .select("*")
      .eq("job_id", jobId)
      .eq("from_stage", "collecting")
      .single(),
  ]);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!collectorHandoff) throw new Error("Collector handoff not found — is Collector done?");

  const { sources } = collectorHandoff.artifact;
  console.log(`[writer] processing job "${job.topic}" — ${sources.length} sources`);

  // 2. Build source context for the LLM
  const sourceContext = sources.map((s, i) =>
    `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    Snippet: ${s.snippet}`
  ).join("\n\n");

  // 3. Draft the brief
  const { content: brief, tokensUsed } = await ollamaChat([
    {
      role: "system",
      content:
        "You are the Writer agent on a multi-agent research desk. " +
        "Write a clear, well-structured research brief in Markdown. " +
        "Requirements:\n" +
        "- Start with a # Title\n" +
        "- Include ## Summary (4-5 sentences giving a thorough overview)\n" +
        "- Include ## Key Findings (6-8 bullet points — each must be 2-3 sentences explaining the finding in depth with context, not just a one-liner)\n" +
        "- Include ## Analysis (2 paragraphs synthesising what the findings mean together)\n" +
        "- Aim for 600-800 words total\n" +
        "- Do NOT include a Sources or References section — sources are shown separately\n" +
        "- Do NOT invent facts beyond what the sources say\n" +
        "- Every claim in Key Findings must have a source citation like [1], [2]",
    },
    {
      role: "user",
      content:
        `Research topic: "${job.topic}"\n\n` +
        `Sources from Collector:\n\n${sourceContext}`,
    },
  ], 2000);

  // 4. Clean the brief — strip Sources/References section and inline [n] markers
  const cleanedBrief = brief
    .replace(/^##\s+(Sources|References|Bibliography|Citations|Further Reading)[^\n]*[\s\S]*/im, "")
    .replace(/\s*\[\d+(?:[,\s]+\d+)*\]/g, "")
    .trim();

  const citations = sources.map((s) => s.url);
  const wordCount = cleanedBrief.split(/\s+/).filter(Boolean).length;

  // 5. Write handoff (idempotent)
  const artifact = {
    title: cleanedBrief.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? job.topic,
    brief_markdown: cleanedBrief,
    citations,
    word_count: wordCount,
    tokens_used: tokensUsed,
  };

  const { error: upsertErr } = await db.from("handoffs").upsert(
    {
      job_id: jobId,
      from_stage: "writing",
      to_stage: "review",
      agent_id: "writer",
      artifact,
      tokens_used: tokensUsed,
    },
    { onConflict: "job_id,from_stage" }
  );
  if (upsertErr) throw new Error(`Handoff upsert failed: ${upsertErr.message}`);

  console.log(`tokens:${tokensUsed}`);
  console.log(`[writer] done — ${wordCount} words, ${citations.length} citations, job ${jobId}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("[writer] fatal:", err.message ?? err);
  process.exit(1);
});
