-- Migration 004: Fix RLS for revise + retry flows, add processed_at to reviews
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run multiple times (uses IF EXISTS / IF NOT EXISTS guards).

-- ─── 1. Allow 'revise' as a valid review decision ──────────────────────────
-- The old policy blocked decision='revise', so the review INSERT always failed
-- and the orchestrator never saw the revise request.
drop policy if exists "reviews: public insert on escalated jobs" on reviews;

create policy "reviews: public insert on escalated jobs"
  on reviews for insert
  with check (
    exists (
      select 1 from jobs j
      where j.id = job_id and j.status = 'escalated'
    )
    and decision in ('approve', 'reject', 'revise')
  );

-- ─── 2. Add processed_at to reviews ────────────────────────────────────────
-- Prevents the orchestrator from re-processing old revise reviews when a job
-- gets escalated a second time (which would create an infinite write loop).
alter table reviews
  add column if not exists processed_at timestamptz;

-- ─── 3. Allow anon to retry a failed job ───────────────────────────────────
-- The original RLS blocked ALL anon UPDATEs on jobs, so the retry button
-- silently failed. This policy allows only the specific failed→queued reset.
drop policy if exists "jobs: public retry failed" on jobs;

create policy "jobs: public retry failed"
  on jobs for update
  using (status = 'failed')
  with check (
    status = 'queued'
    and attempts = 0
    and locked_at is null
    and locked_by is null
  );
