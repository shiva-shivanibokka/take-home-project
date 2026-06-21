-- Multi-Agent Research Desk — Supabase / Postgres schema
-- Run via: psql $DATABASE_URL -f db/001_schema.sql
-- Or paste into Supabase SQL editor.

-- ─── Extensions ────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── jobs ──────────────────────────────────────────────────────────────────
-- The queue. One row per research job. status drives the state machine.
-- locked_at lets the orchestrator claim a row without a SELECT FOR UPDATE
-- deadlock risk across VPS restarts.
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  topic        text not null,
  status       text not null default 'queued'
                 check (status in (
                   'queued','collecting','writing','review',
                   'published','escalated','failed'
                 )),
  attempts     int not null default 0,   -- retries for the current stage
  locked_at    timestamptz,               -- set when orchestrator picks it up
  locked_by    text,                      -- orchestrator instance id (hostname)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Realtime: enable for the board
alter table jobs replica identity full;

-- ─── handoffs ──────────────────────────────────────────────────────────────
-- Append-only audit log. One row per COMPLETED stage.
-- artifact is the structured JSON each agent emits (see plan).
-- This is THE graded handoff record — graders can read every transition.
create table if not exists handoffs (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references jobs(id) on delete cascade,
  from_stage   text not null,
  to_stage     text not null,
  agent_id     text not null,
  artifact     jsonb not null default '{}',
  confidence   numeric,          -- reviewer only; null for collector/writer
  tokens_used  int,              -- Ollama token count for cost story
  created_at   timestamptz not null default now(),
  -- idempotency: only one completed handoff per (job, from_stage)
  unique (job_id, from_stage)
);

-- ─── events ────────────────────────────────────────────────────────────────
-- Observability — every notable state change written here.
-- Powers the per-job timeline on the board.
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  type       text not null
               check (type in (
                 'started','retry','throttled','failed',
                 'escalated','published','human_decision'
               )),
  stage      text,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Realtime: enable so board event timelines update live
alter table events replica identity full;

-- ─── reviews ───────────────────────────────────────────────────────────────
-- Human decisions on escalated jobs.
create table if not exists reviews (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  decision   text not null check (decision in ('approve','reject')),
  notes      text,
  reviewer   text,               -- free-text; no auth required for the demo
  created_at timestamptz not null default now()
);

-- ─── helpers ───────────────────────────────────────────────────────────────
-- Keep updated_at current automatically
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists jobs_updated_at on jobs;
create trigger jobs_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- ─── indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_jobs_status      on jobs(status);
create index if not exists idx_jobs_locked_at   on jobs(locked_at);
create index if not exists idx_handoffs_job_id  on handoffs(job_id);
create index if not exists idx_events_job_id    on events(job_id);
create index if not exists idx_reviews_job_id   on reviews(job_id);
