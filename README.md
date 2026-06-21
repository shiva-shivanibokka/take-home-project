# Multi-Agent Research Desk

> Confer Inc. AI/ML Take-Home — Assignment 5 of 5

A live, public pipeline of three cooperating AI agents that research a topic,
draft a brief, review it for quality, and either publish it or escalate it to
a human. Everything flows through a shared Postgres queue. A deployed board
shows each job in real time.

**Live board:** `<your-vercel-url>`  
**GitHub:** `<this-repo>`

---

## Architecture

```
[Next.js board @ Vercel] ──Supabase realtime──> [Supabase Postgres]
                                                      ▲ jobs · handoffs · events · reviews
                                                      │
                              [Orchestrator @ Oracle VPS]  — state machine, retries, idempotency
                                 │ shells out per stage (one-shot)
                  ┌──────────────┼───────────────┐
           Collector          Writer           Reviewer      (OpenClaw: 3 isolated agents)
           (RSS/HN)       (drafts brief)    (confidence → escalate)
                           LLM: Ollama Cloud (throttle-aware)
```

### Agent responsibilities

| Agent | Stage | What it owns |
|---|---|---|
| **Collector** | `queued → collecting` | Fetches sources from Google News RSS + Hacker News; asks Ollama to score relevance; emits `{ sources, count, notes }` as a JSON handoff record |
| **Writer** | `writing` | Reads the Collector's sources; asks Ollama to draft a Markdown brief with inline citations; emits `{ title, brief_markdown, citations, word_count }` |
| **Reviewer** | `review` | Reads both upstream handoffs; asks Ollama to score 3 checks (citations_supported, coverage, factuality); emits `{ confidence, checks, verdict, reasons }`; confidence < 0.7 or any failed check → **escalate** |

### Handoff contract

Each completed stage writes one row to the `handoffs` table:

```json
{
  "job_id": "...",
  "from_stage": "collecting",
  "to_stage": "writing",
  "agent_id": "collector",
  "artifact": { "sources": [...], "count": 5, "notes": "..." },
  "tokens_used": 128
}
```

Upserted on `(job_id, from_stage)` — **idempotent**: re-running a stage never
duplicates or double-advances.

### Escalation logic

Reviewer `confidence < 0.70` **OR** any check = `false` → `verdict = "escalate"` →
job lands in the **"Needs Human"** column on the board → a grader can Approve
(→ `published`) or Reject (→ `writing` for re-draft).

### Retries

On agent failure or timeout, the orchestrator increments `jobs.attempts` and
backs off exponentially (`8s, 16s, 32s`). After 3 failures → `status = "failed"`.
All retries are recorded in the `events` table and visible in the job's Timeline tab.

---

## Redeploy from scratch

### Prerequisites

- Oracle Cloud Always-Free account with an **Ampere A1 ARM instance** (Ubuntu 22.04+)
- [Supabase](https://supabase.com) free-tier project
- [Vercel](https://vercel.com) account
- GitHub repo forked/cloned

---

### Step 1 — Supabase: create database schema

1. Open your Supabase project → **SQL Editor**
2. Run `db/001_schema.sql`
3. Run `db/002_rls.sql`
4. Run `db/003_realtime.sql`

Note your **Project URL** and both API keys (anon + service_role) from
Settings → API.

---

### Step 2 — Vercel: deploy the board

```bash
cd web
# Install Vercel CLI if needed: npm i -g vercel
vercel
```

Set these environment variables in the Vercel project settings (or via `vercel env add`):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_OLLAMA_MODEL` | `llama3.2:3b` (or your model) |

Redeploy after setting env vars: `vercel --prod`

---

### Step 3 — Oracle VPS: set up agents + orchestrator

SSH into your Oracle ARM instance:

```bash
ssh ubuntu@<your-vps-ip>
```

Clone the repo and create `.env`:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/take-home-project.git ~/research-desk
cd ~/research-desk
cp .env.example .env
nano .env   # fill in Supabase and Ollama values
```

Run the setup script:

```bash
bash infra/setup-vps.sh
```

This installs Node 22, OpenClaw, sets up the three agent workspaces, installs
orchestrator dependencies, and registers + starts the `orchestrator` systemd service.

Verify it's running:

```bash
sudo systemctl status orchestrator
sudo journalctl -u orchestrator -f
```

---

### Step 4 — Verify the pipeline

Open the live board URL and submit **"State of on-device LLMs 2026"**.

Watch the card move:
```
queued → collecting → writing → review → published
```

Click the card → **Handoffs** tab to see the JSON artifact at each stage.

---

## Demo: induced failure + retry

```bash
# On the VPS, while a job is in "writing" stage:
sudo systemctl stop orchestrator
# Wait ~10s — the lock expires
sudo systemctl start orchestrator
# The orchestrator re-picks the job and retries
```

The card's Timeline tab shows `retry` events.

---

## Demo: escalation

Submit a vague or unanswerable topic (e.g. `"aaaa bbbbb"`). The Collector
may find no sources → orchestrator retries → eventually fails. Or submit a
legitimate but thin topic — the Reviewer may emit confidence < 0.7 and
escalate. The card moves to **"Needs Human"**; click it and use the
Approve / Reject buttons.

---

## Cost story

| Component | Cost |
|---|---|
| Oracle VPS (4 cores / 24 GB ARM) | **Free forever** (Always-Free) |
| Supabase (Postgres + realtime) | **Free** (500 MB DB, 2 GB transfer/mo) |
| Vercel (Next.js frontend) | **Free** (Hobby tier) |
| Ollama Cloud | **Free** (rate-limited) |
| **Total** | **$0** |

Token usage is tracked per job in `handoffs.tokens_used` and shown in the
board header. The small model (`llama3.2:3b`) and max-token caps keep each
job under ~2 000 tokens across all three agents.

---

## A+ rubric mapping

| Signal | How we deliver it |
|---|---|
| Durable workflow | All state in Postgres; crash/reboot → orchestrator resumes from locked stage |
| Idempotent handoffs | Upsert on `(job_id, from_stage)`; safe to re-run |
| Confidence-calibrated escalation | Real 3-check rubric + threshold, not a coin flip |
| Pipeline observability | `events` table; per-job timeline on board |
| Clean board UX | Realtime Kanban, artifact drawer, human-review panel |
| Cost story | $0/week, token counts per job visible in board |

---

## File structure

```
/agents-openclaw/   openclaw.json + workspaces (collector|writer|reviewer)
                    Each workspace: SOUL.md (persona), skills/run.mjs (stage logic)
/orchestrator/      TypeScript poll-loop: state machine, locking, retries
/db/                SQL migrations (001_schema, 002_rls, 003_realtime)
/web/               Next.js + shadcn/ui board — deployed to Vercel
/infra/             setup-vps.sh, orchestrator.service (systemd)
.env.example        VPS environment template
README.md           this file
```
