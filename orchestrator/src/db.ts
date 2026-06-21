import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Service-role client: bypasses RLS, used only on the VPS (never in the browser).
export const db = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  { auth: { persistSession: false } }
);

export type JobStatus =
  | "queued"
  | "collecting"
  | "writing"
  | "review"
  | "published"
  | "escalated"
  | "failed";

export type EventType =
  | "started"
  | "retry"
  | "throttled"
  | "failed"
  | "escalated"
  | "published"
  | "human_decision";

export interface Job {
  id: string;
  topic: string;
  status: JobStatus;
  attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── DB helpers ────────────────────────────────────────────────────────────

/** Claim the next ready job by optimistic lock (locked_at + 5-second window). */
export async function claimNextJob(
  readyStatuses: JobStatus[],
  instanceId: string,
  lockTimeoutSecs: number
): Promise<Job | null> {
  // Find a job that is either unlocked OR whose lock has expired.
  const cutoff = new Date(Date.now() - lockTimeoutSecs * 1_000).toISOString();
  const { data, error } = await db
    .from("jobs")
    .select("*")
    .in("status", readyStatuses)
    .or(`locked_at.is.null,locked_at.lt.${cutoff}`)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) return null;

  // Atomically claim the row: update only if it hasn't been grabbed since we read it.
  const { data: claimed, error: claimErr } = await db
    .from("jobs")
    .update({ locked_at: new Date().toISOString(), locked_by: instanceId })
    .eq("id", data.id)
    .or(`locked_at.is.null,locked_at.lt.${cutoff}`)  // guard against race
    .select()
    .single();

  if (claimErr || !claimed) return null;
  return claimed as Job;
}

/** Advance a job to the next stage and release the lock. */
export async function advanceJob(
  jobId: string,
  nextStatus: JobStatus
): Promise<void> {
  await db
    .from("jobs")
    .update({
      status: nextStatus,
      attempts: 0,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", jobId);
}

/** Increment the retry counter or fail the job. */
export async function retryOrFail(
  jobId: string,
  currentAttempts: number,
  maxRetries: number
): Promise<"retry" | "failed"> {
  if (currentAttempts + 1 >= maxRetries) {
    await db
      .from("jobs")
      .update({ status: "failed", locked_at: null, locked_by: null })
      .eq("id", jobId);
    return "failed";
  }
  await db
    .from("jobs")
    .update({ attempts: currentAttempts + 1, locked_at: null, locked_by: null })
    .eq("id", jobId);
  return "retry";
}

/** Write an event row (observability / board timeline). */
export async function writeEvent(
  jobId: string,
  type: EventType,
  stage?: string,
  detail?: Record<string, unknown>
): Promise<void> {
  await db.from("events").insert({
    job_id: jobId,
    type,
    stage: stage ?? null,
    detail: detail ?? {},
  });
}

/** Upsert a handoff record. Idempotent: same (job_id, from_stage) is safe to re-run. */
export async function upsertHandoff(handoff: {
  job_id: string;
  from_stage: string;
  to_stage: string;
  agent_id: string;
  artifact: Record<string, unknown>;
  confidence?: number;
  tokens_used?: number;
}): Promise<void> {
  await db.from("handoffs").upsert(handoff, {
    onConflict: "job_id,from_stage",
  });
}

/** Heartbeat: write an event so the board can show "orchestrator is alive". */
export async function heartbeat(instanceId: string): Promise<void> {
  // We just upsert a synthetic 'started' event with a heartbeat flag.
  // Could also write to a separate health table, but events is sufficient for the demo.
  await db.from("events").insert({
    job_id: "00000000-0000-0000-0000-000000000000", // sentinel — not a real job
    type: "started",
    stage: "orchestrator",
    detail: { heartbeat: true, instance: instanceId, ts: new Date().toISOString() },
  }).then(() => {/* ignore errors on heartbeat */});
}
