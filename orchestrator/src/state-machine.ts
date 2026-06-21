/**
 * state-machine.ts
 *
 * One tick of the orchestrator poll-loop. For each claimable job the
 * state machine:
 *   1. Claims the job (optimistic lock).
 *   2. Invokes the appropriate agent for the current stage.
 *   3. On success → advances to the next stage.
 *   4. On failure → retries (with backoff) or marks failed.
 *
 * The orchestrator NEVER interprets the artifact — it just plumbs job_id
 * through and trusts the agent's DB write. This keeps the three agents
 * genuinely distinct.
 */

import {
  claimNextJob,
  advanceJob,
  retryOrFail,
  writeEvent,
  type JobStatus,
} from "./db.js";
import { invokeAgent, type AgentId } from "./invoke-agent.js";
import { config } from "./config.js";

// ─── Stage map ─────────────────────────────────────────────────────────────
// Which statuses are ready for work, which agent runs, and what status comes next.
interface StageSpec {
  readyStatus: JobStatus;    // job must be in this status to be picked up
  agentId: AgentId;
  nextStatus: JobStatus;     // status to advance to on success
  timeoutMs: number;         // agent-level timeout (LLM calls are slow on free tier)
}

const STAGES: StageSpec[] = [
  {
    readyStatus: "queued",
    agentId: "collector",
    nextStatus: "writing",
    timeoutMs: 90_000,   // 90s: RSS fetch + Ollama summary
  },
  {
    readyStatus: "collecting",
    agentId: "collector",
    nextStatus: "writing",
    timeoutMs: 90_000,
  },
  {
    readyStatus: "writing",
    agentId: "writer",
    nextStatus: "review",
    timeoutMs: 120_000,  // 120s: Ollama draft (throttle-aware)
  },
  {
    readyStatus: "review",
    agentId: "reviewer",
    nextStatus: "published",   // reviewer may override to "escalated"
    timeoutMs: 90_000,
  },
];

// ─── Tick ───────────────────────────────────────────────────────────────────
export async function tick(): Promise<void> {
  const { orchestrator: cfg } = config;

  for (const stage of STAGES) {
    const job = await claimNextJob(
      [stage.readyStatus],
      cfg.instanceId,
      cfg.lockTimeoutSecs
    );
    if (!job) continue;

    const stageName = stage.agentId;
    console.log(`[${stageName}] picked up job ${job.id} — topic: "${job.topic}"`);

    // Mark as "in-progress" status (collecting / writing / review)
    // so the board shows the card moving immediately.
    const inProgressStatus: JobStatus =
      stage.readyStatus === "queued" ? "collecting" : stage.readyStatus;

    if (inProgressStatus !== stage.readyStatus) {
      await writeEvent(job.id, "started", inProgressStatus, {
        agent: stage.agentId,
        attempt: job.attempts,
      });
    }

    // ── invoke the agent ──────────────────────────────────────────────────
    const result = await invokeAgent(stage.agentId, job.id, stage.timeoutMs);

    if (result.success) {
      // Agent wrote its own handoff record to Supabase.
      // We just advance the job status.
      // Special case: Reviewer agent may have written status=escalated itself;
      // we check by re-reading the job status (agent sets it via service-role).
      const { data: refreshed } = await import("./db.js").then(({ db }) =>
        db.from("jobs").select("status").eq("id", job.id).single()
      );

      const finalStatus =
        refreshed?.status === "escalated" ? "escalated" : stage.nextStatus;

      await advanceJob(job.id, finalStatus);
      await writeEvent(job.id, finalStatus === "escalated" ? "escalated" : "published",
        stageName,
        { agent: stage.agentId, tokens: result.stdout.match(/tokens:(\d+)/)?.[1] }
      );

      console.log(`[${stageName}] job ${job.id} → ${finalStatus}`);
    } else {
      // ── failure: retry or fail ──────────────────────────────────────────
      const outcome = await retryOrFail(job.id, job.attempts, cfg.maxRetries);

      if (outcome === "retry") {
        const backoff =
          cfg.backoffBaseMs * Math.pow(2, job.attempts);
        await writeEvent(job.id, "retry", stageName, {
          attempt: job.attempts + 1,
          max: cfg.maxRetries,
          backoff_ms: backoff,
          error: result.stderr.slice(0, 500),
        });
        console.warn(
          `[${stageName}] job ${job.id} retry ${job.attempts + 1}/${cfg.maxRetries} ` +
          `— backoff ${backoff}ms`
        );
        await sleep(backoff);
      } else {
        await writeEvent(job.id, "failed", stageName, {
          error: result.stderr.slice(0, 500),
        });
        console.error(`[${stageName}] job ${job.id} FAILED after ${cfg.maxRetries} attempts`);
      }
    }
  }
}

// ─── Review handler ─────────────────────────────────────────────────────────
// When a human approves/rejects an escalated job, the review is written to
// Supabase by the frontend (anon key + RLS policy). The orchestrator detects
// the new review row and advances the job accordingly.
export async function processHumanReviews(): Promise<void> {
  const { db } = await import("./db.js");

  // Find escalated jobs that now have a review decision.
  const { data: reviews } = await db
    .from("reviews")
    .select("*, jobs!inner(status)")
    .eq("jobs.status", "escalated")
    .order("created_at", { ascending: true });

  if (!reviews?.length) return;

  for (const review of reviews) {
    const nextStatus: JobStatus =
      review.decision === "approve" ? "published" : "writing";

    await advanceJob(review.job_id, nextStatus);
    await writeEvent(review.job_id, "human_decision", "review", {
      decision: review.decision,
      reviewer: review.reviewer,
      notes: review.notes,
    });
    console.log(
      `[human-review] job ${review.job_id} → ${nextStatus} (${review.decision})`
    );
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
