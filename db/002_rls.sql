-- Row Level Security policies
-- The orchestrator (VPS) uses the SERVICE ROLE key — bypasses RLS entirely.
-- The Next.js frontend uses the ANON key — restricted to these policies only.

alter table jobs    enable row level security;
alter table handoffs enable row level security;
alter table events  enable row level security;
alter table reviews enable row level security;

-- ─── jobs ──────────────────────────────────────────────────────────────────
-- Anyone (anon) can read jobs (the board is public).
create policy "jobs: public read"
  on jobs for select using (true);

-- Anon can INSERT a new job (submit-form), but only with status = 'queued'
-- and cannot set locked_at / locked_by.
create policy "jobs: public insert"
  on jobs for insert
  with check (
    status = 'queued'
    and locked_at is null
    and locked_by is null
  );

-- Anon cannot UPDATE or DELETE jobs (orchestrator does that via service role).

-- ─── handoffs ──────────────────────────────────────────────────────────────
create policy "handoffs: public read"
  on handoffs for select using (true);
-- No public insert/update — orchestrator owns handoffs.

-- ─── events ────────────────────────────────────────────────────────────────
create policy "events: public read"
  on events for select using (true);
-- No public insert — orchestrator owns events.

-- ─── reviews ───────────────────────────────────────────────────────────────
create policy "reviews: public read"
  on reviews for select using (true);

-- Anon can insert a review only for a job that is currently 'escalated'.
-- This lets the human-review Approve/Reject buttons work from the browser
-- without exposing a service key.
create policy "reviews: public insert on escalated jobs"
  on reviews for insert
  with check (
    exists (
      select 1 from jobs j
      where j.id = job_id and j.status = 'escalated'
    )
    and decision in ('approve','reject')
  );
