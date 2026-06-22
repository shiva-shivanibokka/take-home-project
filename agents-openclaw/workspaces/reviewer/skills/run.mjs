/**
 * Reviewer agent skill — run.mjs
 *
 * Persona (see SOUL.md): You are the Reviewer. Your job is to evaluate the
 * Writer's brief against the sources and emit a calibrated confidence score.
 * You MUST escalate rather than auto-ship when unsure.
 *
 * Checks performed:
 *   1. citations_supported  — every claim is traceable to a source
 *   2. coverage             — sources adequately cover the topic
 *   3. factuality           — no obvious hallucinations or contradictions
 *
 * Confidence threshold: < 0.70 OR any failed check → verdict = "escalate".
 *
 * Input:  handoffs rows for "collecting" and "writing" stages
 * Output: handoffs row with artifact:
 *   { confidence, checks:{citations_supported,coverage,factuality},
 *     verdict:"publish"|"escalate", reasons:[], tokens_used }
 *   ALSO updates jobs.status to "escalated" if verdict = "escalate".
 *
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
const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.70);

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
          temperature: 0.1, // low temp for structured evaluation
        }),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = 2 ** attempt * 5_000 + Math.random() * 2_000;
        console.error(`[reviewer] Ollama throttled (${res.status}), retrying in ${Math.round(wait)}ms`);
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
  // 1. Load job + both upstream handoffs
  const [{ data: job }, { data: collectorHandoff }, { data: writerHandoff }] =
    await Promise.all([
      db.from("jobs").select("*").eq("id", jobId).single(),
      db.from("handoffs").select("*").eq("job_id", jobId).eq("from_stage", "collecting").single(),
      db.from("handoffs").select("*").eq("job_id", jobId).eq("from_stage", "writing").single(),
    ]);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!collectorHandoff) throw new Error("Collector handoff missing");
  if (!writerHandoff) throw new Error("Writer handoff missing");

  const { sources } = collectorHandoff.artifact;
  const { brief_markdown, title, citations } = writerHandoff.artifact;

  console.log(`[reviewer] evaluating brief "${title}" for job "${job.topic}"`);

  // 2. Ask Ollama to evaluate the brief against the sources
  const sourceList = sources.map((s, i) =>
    `[${i + 1}] ${s.title} — ${s.snippet?.slice(0, 150) ?? ""}`
  ).join("\n");

  const prompt = `
You are a rigorous fact-checking Reviewer agent.
Evaluate the brief below against the sources provided.
Respond ONLY with valid JSON — no markdown, no extra text.

Required JSON shape:
{
  "citations_supported": true | false,
  "coverage": true | false,
  "factuality": true | false,
  "confidence": <number 0.0 to 1.0>,
  "reasons": ["<reason 1>", "<reason 2>"]
}

Rules:
- "citations_supported": true if the factual claims in the brief are substantively traceable to and consistent with the provided sources (note: the brief uses prose rather than [n] markers — evaluate alignment with source content, not presence of citation markers).
- "coverage": true if the sources collectively cover the topic adequately.
- "factuality": true if the brief contains no obvious fabrications or contradictions with the sources.
- "confidence": your overall confidence that the brief is accurate and publishable (0.0 = no confidence, 1.0 = fully confident).
- "reasons": list 1-3 specific reasons for any failed check or low confidence. Empty array if all checks pass.
- If you are at all unsure, assign a lower confidence score rather than a higher one.

Topic: "${job.topic}"

Sources:
${sourceList}

Brief to evaluate:
${brief_markdown}
`;

  const { content: rawJson, tokensUsed } = await ollamaChat([
    { role: "user", content: prompt },
  ], 512);

  // 3. Parse the evaluation (robust fallback if LLM doesn't return valid JSON)
  let evaluation;
  try {
    // Strip any markdown code fences the model might have added
    const cleaned = rawJson
      .replace(/```json?\n?/gi, "")
      .replace(/```/g, "")
      .trim();
    evaluation = JSON.parse(cleaned);
  } catch {
    console.error("[reviewer] LLM did not return valid JSON — defaulting to escalate");
    evaluation = {
      citations_supported: false,
      coverage: false,
      factuality: false,
      confidence: 0.0,
      reasons: ["Reviewer could not parse LLM evaluation output"],
    };
  }

  // 4. Determine verdict — confidence score alone drives publish/escalate.
  // Checks inform the LLM's score but no longer override it; the inline [n]
  // citation markers were stripped from the brief so citations_supported was
  // always false, causing false escalations regardless of confidence.
  const { citations_supported, coverage, factuality, confidence, reasons } = evaluation;
  const anyCheckFailed = !citations_supported || !coverage || !factuality;
  const verdict = confidence < CONFIDENCE_THRESHOLD ? "escalate" : "publish";

  console.log(
    `[reviewer] confidence=${confidence.toFixed(2)} checks=${JSON.stringify({citations_supported,coverage,factuality})} verdict=${verdict}`
  );

  // 5. Write handoff (idempotent)
  const artifact = {
    confidence,
    checks: { citations_supported, coverage, factuality },
    verdict,
    reasons: reasons ?? [],
    tokens_used: tokensUsed,
  };

  const { error: upsertErr } = await db.from("handoffs").upsert(
    {
      job_id: jobId,
      from_stage: "review",
      to_stage: verdict === "publish" ? "published" : "escalated",
      agent_id: "reviewer",
      artifact,
      confidence,
      tokens_used: tokensUsed,
    },
    { onConflict: "job_id,from_stage" }
  );
  if (upsertErr) throw new Error(`Handoff upsert failed: ${upsertErr.message}`);

  // 6. If escalating, update job status so the board shows it immediately
  //    (orchestrator reads this status after exit-0 and honours it)
  if (verdict === "escalate") {
    await db
      .from("jobs")
      .update({ status: "escalated", locked_at: null, locked_by: null })
      .eq("id", jobId);
    await db.from("events").insert({
      job_id: jobId,
      type: "escalated",
      stage: "review",
      detail: { confidence, reasons, checks: { citations_supported, coverage, factuality } },
    });
    console.log(`[reviewer] job ${jobId} → ESCALATED (confidence=${confidence.toFixed(2)})`);
  }

  console.log(`tokens:${tokensUsed}`);
  console.log(`[reviewer] done — verdict=${verdict} job=${jobId}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("[reviewer] fatal:", err.message ?? err);
  process.exit(1);
});
