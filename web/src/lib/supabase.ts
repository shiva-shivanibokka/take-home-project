import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Anon client — safe to ship to the browser; RLS restricts write access.
export const supabase = createClient(url, anon);

// ─── Types ──────────────────────────────────────────────────────────────────
export type JobStatus =
  | "queued" | "collecting" | "writing" | "review"
  | "published" | "escalated" | "failed";

export interface Job {
  id: string;
  topic: string;
  status: JobStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface Handoff {
  id: string;
  job_id: string;
  from_stage: string;
  to_stage: string;
  agent_id: string;
  artifact: Record<string, unknown>;
  confidence: number | null;
  tokens_used: number | null;
  created_at: string;
}

export interface Event {
  id: string;
  job_id: string;
  type: string;
  stage: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Review {
  id: string;
  job_id: string;
  decision: "approve" | "reject";
  notes: string | null;
  reviewer: string | null;
  created_at: string;
}

// ─── Stage ordering for the board columns ───────────────────────────────────
export const STAGE_ORDER: JobStatus[] = [
  "queued",
  "collecting",
  "writing",
  "review",
  "published",
  "escalated",
  "failed",
];

export const STAGE_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  collecting: "Collecting",
  writing: "Writing",
  review: "Review",
  published: "Published",
  escalated: "Needs Human",
  failed: "Failed",
};

export const STAGE_COLORS: Record<JobStatus, string> = {
  queued:     "bg-slate-100 text-slate-700",
  collecting: "bg-blue-100 text-blue-700",
  writing:    "bg-violet-100 text-violet-700",
  review:     "bg-amber-100 text-amber-700",
  published:  "bg-green-100 text-green-700",
  escalated:  "bg-orange-100 text-orange-800",
  failed:     "bg-red-100 text-red-700",
};
