# Multi-Agent Research Desk

> Confer Inc. · AI/ML Engineering Take-Home · Assignment 5 of 5

A production-grade pipeline of three cooperating AI agents that research any topic, draft a structured brief, and review it for quality — escalating low-confidence work to a human instead of auto-publishing. Every job flows through a shared Postgres queue; a live board shows each stage in real time.

**Live board:** https://take-home-project-git-main-shiv-a.vercel.app/



**GitHub:** https://github.com/shiva-shivanibokka/take-home-project

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Pipeline flow](#pipeline-flow)
4. [Database schema](#database-schema)
5. [Agent details](#agent-details)
6. [Handoff contract](#handoff-contract)
7. [Escalation and human review](#escalation-and-human-review)
8. [Retry and failure recovery](#retry-and-failure-recovery)
9. [Frontend features](#frontend-features)
10. [Cost and token discipline](#cost-and-token-discipline)
11. [A+ rubric mapping](#a-rubric-mapping)
12. [Redeploy from scratch](#redeploy-from-scratch)
13. [Environment variables reference](#environment-variables-reference)
14. [Repo structure](#repo-structure)
15. [Verification steps](#verification-steps)

---

## What it does

Submit a research topic (e.g. *"Anthropic Claude vs GPT-4o enterprise adoption 2025"*) and watch three AI agents cooperate to produce a published brief:

1. **Collector** — searches Google News RSS and Hacker News, deduplicates by domain, asks an LLM to score relevance, and selects the 7 best sources.
2. **Writer** — reads the curated sources and drafts a 600–800-word Markdown brief with Summary, Key Findings, and Analysis sections.
3. **Reviewer** — evaluates the brief against the sources on three checks (citation support, coverage, factuality) and emits a calibrated confidence score. Briefs above 70% confidence auto-publish; below 70% → escalated to a human.

Human reviewers can **Approve** (publish), **Reject** (fail), or **Revise with AI** — typing specific instructions that are injected directly into the Writer's LLM prompt for a targeted re-draft. If the revision passes the 70% bar it auto-publishes; if not, it escalates again for another round.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Next.js board @ Vercel                     │
│   Submit form · Chat-style job view · Sidebar job history    │
│   Collapsible COT · Sources · Brief · PDF download           │
└───────────────────────┬─────────────────────────────────────┘
                        │  Supabase Realtime (websocket)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              Supabase (hosted Postgres)                      │
│   jobs · handoffs (audit) · events (observability) · reviews │
└───────────────────────┬─────────────────────────────────────┘
                        │  service-role key (server-side only)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│           Orchestrator — Oracle Always-Free VPS              │
│   TypeScript poll-loop · state machine · optimistic locking  │
│   Retries · exponential backoff · heartbeat                  │
│   Managed by PM2 (auto-restart on crash/reboot)              │
└──────────┬──────────────┬────────────────┬──────────────────┘
           │              │                │
      node run.mjs   node run.mjs    node run.mjs
           │              │                │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐
    │  Collector  │ │   Writer   │ │   Reviewer   │
    │  (OpenClaw) │ │ (OpenClaw) │ │  (OpenClaw)  │
    │             │ │            │ │              │
    │ Google News │ │ LLM draft  │ │ LLM evaluate │
    │ HN Algolia  │ │ 600-800 wds│ │ confidence   │
    │ Domain dedup│ │            │ │ → publish or │
    │ 7 sources   │ │            │ │   escalate   │
    └─────────────┘ └────────────┘ └──────────────┘
              All three agents: Groq API (llama-3.1-8b-instant)
```

### Key design decisions

| Decision | Rationale |
|---|---|
| **Deterministic DB state machine** instead of Temporal | Postgres + optimistic locking is durable, crash-safe, and free-tier-friendly. On crash/reboot the orchestrator resumes from the locked stage — no workflow engine needed. |
| **Groq API (free tier)** | 14,400 tokens/minute, 500K/day. Much faster than Ollama Cloud for the demo window. Model: `llama-3.1-8b-instant`. |
| **Supabase realtime** | Board updates live without polling — every status change the board receives instantly via websocket. |
| **Anon key in browser, service-role on VPS** | RLS policies restrict what the browser can do (read-only + submit jobs + insert reviews). The orchestrator bypasses RLS to advance job state. |
| **OpenClaw per agent** | Each agent has its own workspace with a `SOUL.md` persona and isolated `skills/run.mjs` — genuine separation of concerns, not one mega-prompt. |

---

## Pipeline flow

```
[User submits topic]
       │
       ▼
  status = queued
       │
       ▼ Orchestrator claims job (optimistic lock)
  status = collecting
       │
       ▼ Collector agent runs (node skills/run.mjs --job <id>)
       │   · Fetches 12 Google News + 8 HN items
       │   · Deduplicates by domain
       │   · Scores relevance via LLM (128 max tokens)
       │   · Selects 7 best sources
       │   · Writes handoff artifact to DB
  status = writing
       │
       ▼ Writer agent runs
       │   · Reads collector handoff from DB
       │   · If a "revise" review exists → injects human instructions into prompt
       │   · Drafts 600–800 word Markdown brief (2000 max tokens)
       │   · Strips Sources section and [n] markers (stored clean)
       │   · Writes handoff artifact to DB
  status = review
       │
       ▼ Reviewer agent runs
       │   · Reads both upstream handoffs from DB
       │   · Evaluates: citations_supported, coverage, factuality
       │   · Emits confidence score 0.0–1.0 (512 max tokens)
       │   · confidence ≥ 0.70 → verdict = "publish"
       │   · confidence < 0.70 → verdict = "escalate"
       │
       ├──────────────────────────────┐
       ▼                              ▼
  status = published           status = escalated
  (board sidebar:              (board sidebar: "Needs Human")
   "Published")                       │
                                      ▼ Human review panel
                               ┌──────┴──────────────┐
                               │  Approve → published │
                               │  Revise  → writing   │ ← writer re-runs with instructions
                               │  Reject  → failed    │
                               └─────────────────────┘
```

---

## Database schema

Four tables in Supabase Postgres. Migrations in `db/`.

### `jobs` — the queue

```sql
id         uuid  (primary key)
topic      text
status     text  -- queued | collecting | writing | review | published | escalated | failed
attempts   int   -- retry counter for current stage
locked_at  timestamptz  -- set when orchestrator claims the job
locked_by  text         -- orchestrator instance ID (hostname)
created_at timestamptz
updated_at timestamptz  -- auto-updated by trigger
```

### `handoffs` — the audit trail (append-only per stage)

One row per completed stage. This is **the graded handoff record**.

```sql
id         uuid
job_id     uuid → jobs(id)
from_stage text  -- "collecting" | "writing" | "review"
to_stage   text  -- next stage
agent_id   text  -- "collector" | "writer" | "reviewer"
artifact   jsonb -- structured output (see Handoff contract below)
confidence numeric  -- reviewer only; null for collector/writer
tokens_used int
created_at timestamptz
UNIQUE (job_id, from_stage)  -- idempotency key
```

### `events` — observability

Every notable state change. Visible per-job in the COT (chain-of-thought) panel.

```sql
id       uuid
job_id   uuid → jobs(id)
type     text  -- started | retry | throttled | failed | escalated | published | human_decision
stage    text
detail   jsonb -- { agent, tokens, error, decision, etc. }
created_at timestamptz
```

### `reviews` — human decisions

```sql
id           uuid
job_id       uuid → jobs(id)
decision     text  -- approve | reject | revise
notes        text  -- revision instructions (for "revise" decisions)
reviewer     text  -- free-text name, no auth
processed_at timestamptz  -- set by orchestrator after handling; prevents replay loops
created_at   timestamptz
```

---

## Agent details

### Collector

**Persona (`SOUL.md`):** Only gathers. Never writes prose. Never invents sources. Either a URL is real or it isn't.

**What it does:**
- Fetches up to 12 items from Google News RSS and 8 from HN Algolia search
- Deduplicates candidates by domain (`new URL(src.url).hostname`) — prevents 5 items from the same outlet
- Scores relevance with the LLM using 120-char snippets (short to stay within token limits) and stores 350-char snippets in the artifact
- Selects the 7 highest-relevance sources; falls back to top-7 if LLM returns malformed JSON
- Emits handoff: `{ sources: [{title, url, snippet, published, source}], count, notes, tokens_used }`

**Token budget:** ~400–600 tokens per job (128 max for LLM scoring call).

### Writer

**Persona (`SOUL.md`):** Faithful to sources. Never invents facts. Every claim must trace to a source.

**What it does:**
- Reads the Collector's source list from the `handoffs` table
- Checks `reviews` table for any `decision='revise'` row — if found, appends the human reviewer's instructions to the LLM user message
- Drafts a Markdown brief:
  - `# Title`
  - `## Summary` (4–5 sentences)
  - `## Key Findings` (6–8 bullets, each 2–3 sentences with context)
  - `## Analysis` (2 paragraphs)
- Strips `## Sources` sections and inline `[n]` markers before storing (sources shown separately in UI)
- Emits handoff: `{ title, brief_markdown, citations: [url, ...], word_count, tokens_used }`

**Token budget:** ~1,500–2,500 tokens per job (2000 max output).

**Revision-aware:** On a revise cycle, the Writer appends:
> *"A human reviewer has read a previous draft and requests these specific revisions: [instructions]. Please incorporate this feedback into your brief."*

### Reviewer

**Persona (`SOUL.md`):** Calibrated. Cautious. Prefers escalation over false confidence.

**What it does:**
- Reads both upstream handoffs (sources + brief)
- Evaluates three checks:
  - `citations_supported` — claims substantively traceable to sources (evaluated on content alignment, not marker presence)
  - `coverage` — sources collectively cover the topic
  - `factuality` — no obvious fabrications or contradictions
- Emits confidence score 0.0–1.0 and reasons for any concerns
- **Verdict logic:** `confidence ≥ 0.70 → publish`, `confidence < 0.70 → escalate`
- Immediately writes `status='escalated'` to `jobs` so the board updates before the orchestrator's next tick
- Emits handoff: `{ confidence, checks: {citations_supported, coverage, factuality}, verdict, reasons, tokens_used }`

**Token budget:** ~800–1,200 tokens per job (512 max output).

---

## Handoff contract

Each agent writes exactly one row to `handoffs` upon completion. The orchestrator reads the job's exit code (0 = success) and advances `jobs.status`. It never interprets the artifact content — that is the next agent's job.

**Example — Collector handoff:**
```json
{
  "job_id": "3f8a...",
  "from_stage": "collecting",
  "to_stage": "writing",
  "agent_id": "collector",
  "artifact": {
    "sources": [
      {
        "title": "Anthropic releases Claude 3.7 with extended thinking",
        "url": "https://techcrunch.com/...",
        "snippet": "Anthropic today released Claude 3.7, featuring...",
        "published": "Mon, 01 Apr 2026 09:00:00 GMT",
        "source": "TechCrunch"
      }
    ],
    "count": 7,
    "notes": "Fetched 18 candidates; deduped to 14; selected 7 for Writer.",
    "tokens_used": 412
  },
  "tokens_used": 412
}
```

**Idempotency:** The `UNIQUE (job_id, from_stage)` constraint plus `INSERT ... ON CONFLICT DO UPDATE` means re-running a stage always replaces the previous artifact — never duplicates, never double-advances. This makes retries safe.

---

## Escalation and human review

### Automatic escalation

When the Reviewer's confidence score falls below **0.70**, the job is escalated:
- `jobs.status` is set to `'escalated'` immediately by the Reviewer agent
- The job appears in the **"Needs Human"** section of the sidebar
- The board shows the Reviewer's confidence score and specific reasons

### Human review panel (three actions)

The escalated job shows a review panel with:

**✓ Approve & Publish** — Inserts a `decision='approve'` review row. Orchestrator advances the job to `published`. The brief moves to the **Published** sidebar section.

**↺ Revise with AI** — (Only active when instructions are typed.) Inserts a `decision='revise'` review row with the reviewer's typed instructions as `notes`. Orchestrator resets `jobs.status='writing'`. The Writer re-runs and reads the latest `revise` review — injecting the instructions directly into its LLM prompt. After the Writer completes, the Reviewer runs again:
- If new confidence ≥ 0.70 → auto-published
- If still < 0.70 → escalated again for another round

This loop can continue indefinitely, with each round of human feedback improving the brief.

**✗ Reject** — Inserts a `decision='reject'` review row. Orchestrator sets `jobs.status='failed'`. The job moves to the **Failed** sidebar section.

### Replay protection

Each `review` row has a `processed_at` timestamp. The orchestrator filters `WHERE processed_at IS NULL` when polling for unhandled reviews, and marks each review as processed after handling. This prevents an old `revise` review from triggering infinite re-drafts if a job gets escalated a second time.

---

## Retry and failure recovery

### Automatic retries (orchestrator)

On any agent failure (non-zero exit, timeout, or unhandled exception):

1. Orchestrator increments `jobs.attempts`
2. Backs off exponentially: `8s × 2^attempt` (8s → 16s → 32s)
3. Re-invokes the same agent
4. After **3 failures** → `status='failed'`, `event:failed` written

Agent timeouts: Collector 90s, Writer 120s, Reviewer 90s. If an agent hangs, it's killed at the timeout boundary and treated as a failure.

**Stale lock recovery:** If the orchestrator crashes mid-agent run, the `locked_at` timestamp expires after 120 seconds. On restart, the orchestrator will re-claim and re-run the stage.

All retry events are visible in the job's chain-of-thought panel on the board.

### Manual retry (UI)

Failed jobs show a **↺ Retry this job** button that resets `status='queued'`, `attempts=0` — the orchestrator picks it up and runs the full pipeline from the Collector.

---

## Frontend features

### Chat-style layout

The board presents research jobs as a conversation:
- **User bubble** (right-aligned, blue-tinted) — the submitted topic
- **Agent response card** (white, left border) — the full pipeline output

### Left sidebar (290px)

Completed jobs organised into three collapsible sections:
- **Published** — approved briefs
- **Needs Human** — escalated jobs awaiting review
- **Failed** — jobs that exhausted retries or were rejected

Clicking any sidebar entry opens it in history mode. A **← Back to live** button returns to the current live job.

### Chain-of-thought (COT) panel

A flat, scrolling stream styled after Claude/ChatGPT extended thinking:
- Agent labels with pulsing activity dots and ✓ completion marks
- Animated thought lines for each processing step
- `─── handoff: collecting → writing · 7 sources ───` dividers between stages
- Token counts per agent
- Auto-collapses on pipeline completion; re-opens on new jobs

### Sources panel (collapsible)

Shows the Collector's 7 selected sources as clickable cards with title, publication name, date, and snippet. Becomes visible once the Collector stage completes.

### Brief panel

The Writer's Markdown brief rendered with `react-markdown`. The `## Sources` / `## References` section and inline `[n]` citation markers are stripped at render time (sources are shown in the Sources panel). This cleanup applies to all jobs regardless of when they were stored.

### PDF download

Published and escalated briefs have a **Download PDF** button that opens a print-ready page in a new tab.

### Header stats

Real-time counters: Running · Published · Needs Review · Failed.

---

## Cost and token discipline

All infrastructure is permanently free:

| Component | Provider | Cost |
|---|---|---|
| VPS (4 vCPUs / 24 GB RAM, ARM) | Oracle Cloud Always-Free | **$0 forever** |
| Postgres + Realtime | Supabase free tier (500 MB DB) | **$0** |
| Frontend | Vercel Hobby tier | **$0** |
| LLM API | Groq free tier | **$0** (14,400 tokens/min, 500K/day) |
| **Total** | | **$0/week** |

**Token caps per job:**

| Agent | Max output tokens | Typical total |
|---|---|---|
| Collector (scoring) | 128 | ~400–600 |
| Writer (brief) | 2,000 | ~1,500–2,500 |
| Reviewer (evaluation) | 512 | ~800–1,200 |
| **Per job** | | **~2,700–4,300** |

At Groq's free-tier rate of 14,400 tokens/minute, a typical job completes in under 60 seconds. The orchestrator backs off on 429 responses with exponential jitter. Token usage is stored in `handoffs.tokens_used` per stage.

---

## A+ rubric mapping

| Rubric signal | How this project delivers it |
|---|---|
| **Durable workflow** *(e.g. Temporal)* | All state persists in Postgres. On crash or reboot, the orchestrator reads `locked_at`; expired locks are re-claimed and the stage re-runs. Jobs never lose progress. |
| **Idempotent handoffs** | `UPSERT ON CONFLICT (job_id, from_stage)` — re-running a stage replaces the artifact, never duplicates or double-advances. |
| **Confidence-calibrated escalation** | Reviewer emits a real `0.0–1.0` confidence float from three explicit checks. Threshold is 0.70. Reasons are stored and shown to the human reviewer. |
| **Pipeline observability** | `events` table captures every state transition with timestamps and detail. Shown as a live-updating chain-of-thought stream in the UI. |
| **Clean board UX** | Chat-style layout with sidebar job history, collapsible COT, sources, brief, PDF export, and a human review panel with three actions. |
| **Cost story** | $0/week total. Per-job token counts stored and visible. Model and token caps chosen to fit within the Groq free tier. |
| **Human-in-the-loop revision** *(beyond A+)* | Reviewer can type specific revision instructions; Writer re-runs with them injected into the LLM prompt; auto-publishes if confidence recovers. |

---

## Redeploy from scratch

Everything needed to stand up a fresh instance from zero.

### Prerequisites

- Oracle Cloud Always-Free account → Ampere A1 ARM instance (Ubuntu 22.04/24.04, 1–4 vCPUs, 6–24 GB RAM)
- [Supabase](https://supabase.com) free-tier project
- [Vercel](https://vercel.com) account (connect your GitHub fork)
- [Groq](https://console.groq.com) account (free API key)
- Node.js 22 on the VPS (installed by setup script)

---

### Step 1 — Supabase: create the schema

1. Open your Supabase project → **SQL Editor → New query**
2. Paste and run each file in order:

```
db/001_schema.sql   — tables, indexes, updated_at trigger
db/002_rls.sql      — Row Level Security (anon vs service-role separation)
db/003_realtime.sql — enable realtime publication on jobs, events, handoffs, reviews
db/004_rls_and_reviews_fix.sql — RLS for revise/retry flows + processed_at column
```

3. Go to **Settings → API** and note:
   - **Project URL** (e.g. `https://xyzxyz.supabase.co`)
   - **anon public** key
   - **service_role** key (keep this server-side only)

---

### Step 2 — Vercel: deploy the frontend

1. Fork/push the repo to GitHub, then import it in Vercel.
2. Set **Root Directory** to `web`.
3. Add these environment variables in the Vercel project settings:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |

4. Deploy. Note the live URL (e.g. `https://your-project.vercel.app`).

Vercel auto-deploys on every push to `main`.

---

### Step 3 — Oracle VPS: install Node, PM2, and dependencies

SSH in:

```bash
ssh <your-username>@<your-vps-ip>
```

Install Node 22 and PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
```

Clone the repo:

```bash
git clone https://github.com/shiva-shivanibokka/take-home-project.git ~/take-home-project
cd ~/take-home-project
```

---

### Step 4 — Configure environment variables

Create the root `.env` (used by the orchestrator and all three agent skills):

```bash
cp .env.example .env
nano .env
```

Fill in:

```bash
# Supabase
SUPABASE_URL=https://xyzxyz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # service_role key — server only

# Groq (used as Ollama-compatible endpoint)
OLLAMA_BASE_URL=https://api.groq.com/openai
OLLAMA_MODEL=llama-3.1-8b-instant
OLLAMA_API_KEY=gsk_...             # your Groq API key

# OpenClaw workspaces
OPENCLAW_WORKSPACES_ROOT=/home/<your-username>/take-home-project/agents-openclaw/workspaces

# Orchestrator tuning (defaults shown)
POLL_INTERVAL_MS=5000
LOCK_TIMEOUT_SECS=120
MAX_RETRIES=3
BACKOFF_BASE_MS=8000
CONFIDENCE_THRESHOLD=0.70
```

---

### Step 5 — Install OpenClaw and agent dependencies

```bash
sudo npm install -g openclaw@latest

# Install dependencies for each agent skill
for agent in collector writer reviewer; do
  cd ~/take-home-project/agents-openclaw/workspaces/$agent/skills
  npm install
done
```

---

### Step 6 — Build and start the orchestrator

```bash
cd ~/take-home-project/orchestrator
npm install
npm run build

# Start with PM2
pm2 start dist/index.js --name orchestrator

# Persist across reboots
pm2 startup    # run the printed command (sudo env ...)
pm2 save
```

Verify it's running:

```bash
pm2 status
pm2 logs orchestrator --lines 30
```

---

### Step 7 — Verify the pipeline end-to-end

Open the live board URL and submit: **"State of on-device LLMs 2026"**

Watch the job move through:
```
queued → collecting → writing → review → published
```

The chain-of-thought panel shows each agent's reasoning in real time.

---

## Environment variables reference

### VPS `.env` (orchestrator + agent skills)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | Service-role key (bypasses RLS) — never expose to browser |
| `OLLAMA_BASE_URL` | ✅ | — | LLM API base URL (e.g. `https://api.groq.com/openai`) |
| `OLLAMA_MODEL` | ✅ | — | Model name (e.g. `llama-3.1-8b-instant`) |
| `OLLAMA_API_KEY` | ✅ | — | API key for the LLM provider (Groq) |
| `OPENCLAW_WORKSPACES_ROOT` | ✅ | — | Absolute path to `agents-openclaw/workspaces` |
| `POLL_INTERVAL_MS` | — | `5000` | How often the orchestrator polls for new jobs (ms) |
| `LOCK_TIMEOUT_SECS` | — | `120` | Seconds before a stale job lock expires |
| `MAX_RETRIES` | — | `3` | Per-stage retry limit before marking failed |
| `BACKOFF_BASE_MS` | — | `8000` | Base backoff (doubles each retry: 8s, 16s, 32s) |
| `CONFIDENCE_THRESHOLD` | — | `0.70` | Reviewer score below which a job is escalated |

### Vercel environment variables (frontend)

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key (safe to expose in browser) |

---

## Repo structure

```
/
├── agents-openclaw/
│   ├── openclaw.json                  OpenClaw agent registry
│   └── workspaces/
│       ├── collector/
│       │   ├── SOUL.md                Agent persona + boundaries
│       │   └── skills/
│       │       └── run.mjs            Stage logic: fetch → score → select → write handoff
│       ├── writer/
│       │   ├── SOUL.md
│       │   └── skills/
│       │       └── run.mjs            Stage logic: read sources → LLM draft → write handoff
│       └── reviewer/
│           ├── SOUL.md
│           └── skills/
│               └── run.mjs            Stage logic: evaluate → confidence → verdict → write handoff
│
├── orchestrator/
│   ├── src/
│   │   ├── index.ts                   Poll loop entry point (tick + processHumanReviews every 5s)
│   │   ├── state-machine.ts           Stage map, tick(), processHumanReviews()
│   │   ├── db.ts                      Supabase client, claimNextJob, advanceJob, retryOrFail
│   │   ├── invoke-agent.ts            Shells out to node skills/run.mjs --job <id>
│   │   └── config.ts                  Env var loading with validation
│   ├── package.json
│   └── tsconfig.json
│
├── web/
│   └── src/
│       ├── app/
│       │   ├── page.tsx               Main layout: header, sidebar, chat panel
│       │   └── globals.css            Animations: card-arrive, thought-in, dot-pulse, etc.
│       ├── components/
│       │   └── ChatMessage.tsx        Full job view: COT, sources, brief, human review panel
│       └── lib/
│           └── supabase.ts            Anon client + type definitions
│
├── db/
│   ├── 001_schema.sql                 Tables, indexes, updated_at trigger
│   ├── 002_rls.sql                    Row Level Security policies
│   ├── 003_realtime.sql               Supabase realtime publication
│   └── 004_rls_and_reviews_fix.sql    RLS for revise/retry + processed_at column
│
├── infra/
│   ├── setup-vps.sh                   One-shot VPS setup script
│   └── orchestrator.service           systemd unit (alternative to PM2)
│
├── .env.example                       VPS environment template
├── web/.env.example                   Vercel environment template
└── README.md                          This file
```

---

## Verification steps

### Happy path

1. Open the board → submit **"OpenAI o3 reasoning model benchmarks 2025"**
2. Watch: `queued → collecting (7 sources logged) → writing (brief drafted) → review → published`
3. Click the card → expand **Reasoning** to see agent logs and handoff dividers
4. Click **Sources** to see the 7 curated links
5. Read the brief → click **Download PDF**

### Escalation + human review

1. Submit a thin or ambiguous topic — e.g. **"very obscure niche topic with no coverage"**
2. Reviewer will emit confidence < 0.70 → card moves to **Needs Human**
3. In the review panel: type revision instructions → click **↺ Revise with AI**
4. Watch the Writer re-run in live mode with the instructions applied
5. If the new brief scores ≥ 0.70 → auto-published; otherwise escalated again

### Induced failure + retry

```bash
# While a job is in "writing" stage, kill the orchestrator on the VPS:
pm2 stop orchestrator

# Wait ~120 seconds for the stale lock to expire, then:
pm2 start orchestrator

# The orchestrator re-picks the job and retries the Writer stage
# The job's chain-of-thought panel shows a "retry" event
```

### Manual retry (failed jobs)

1. Let any job exhaust its 3 retries → `status=failed`
2. In the **Failed** sidebar section, click the failed job
3. Click **↺ Retry this job**
4. The job resets to `queued` and runs the full pipeline from scratch

### Reboot durability

```bash
sudo reboot
# After ~30s, SSH back in:
pm2 status   # orchestrator should be Running (PM2 startup was configured)
# Any in-flight jobs whose lock expired will be re-picked up automatically
```
