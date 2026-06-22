"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  supabase,
  STAGE_LABELS,
  type Job,
  type JobStatus,
  type Handoff,
  type Event,
  type Review,
} from "@/lib/supabase";

// ── Artifact shapes ────────────────────────────────────────────────────────────

interface Source {
  title: string;
  url: string;
  snippet: string;
  published: string;
  source: string;
}

interface CollectorArtifact {
  sources: Source[];
  count: number;
  notes: string;
  tokens_used: number;
}

interface WriterArtifact {
  title: string;
  brief_markdown: string;
  citations: string[];
  word_count: number;
}

interface ReviewerArtifact {
  confidence: number;
  checks: { citations_supported: boolean; coverage: boolean; factuality: boolean };
  verdict: "publish" | "escalate";
  reasons: string[];
}

type StageStatus = "pending" | "active" | "complete" | "failed";

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveStageStatus(
  stage: "collecting" | "writing" | "review",
  job: Job,
  hasHandoff: boolean
): StageStatus {
  if (hasHandoff) return "complete";
  if (job.status === stage) return "active";
  if (job.status === "published" || job.status === "escalated") return "complete";
  const order = ["queued", "collecting", "writing", "review"];
  if (job.status === "failed" && order.indexOf(job.status) >= order.indexOf(stage)) return "failed";
  return order.indexOf(job.status) > order.indexOf(stage) ? "complete" : "pending";
}

function downloadMarkdown(topic: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function PipelineView({ job, onDecision }: { job: Job; onDecision: () => void }) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [events,   setEvents]   = useState<Event[]>([]);
  const [reviews,  setReviews]  = useState<Review[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [notes,    setNotes]    = useState("");
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    setHandoffs([]);
    setEvents([]);
    setReviews([]);

    async function load() {
      const [h, e, r] = await Promise.all([
        supabase.from("handoffs").select("*").eq("job_id", job.id).order("created_at"),
        supabase.from("events").select("*").eq("job_id", job.id).order("created_at"),
        supabase.from("reviews").select("*").eq("job_id", job.id).order("created_at"),
      ]);
      if (h.data) setHandoffs(h.data as Handoff[]);
      if (e.data) setEvents(e.data as Event[]);
      if (r.data) setReviews(r.data as Review[]);
    }
    load();

    const ch = supabase
      .channel(`pipeline-${job.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoffs", filter: `job_id=eq.${job.id}` },
        (p) => setHandoffs((prev) => [...prev, p.new as Handoff])
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `job_id=eq.${job.id}` },
        (p) => setEvents((prev) => [...prev, p.new as Event])
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [job.id]);

  const decide = async (decision: "approve" | "reject") => {
    setDeciding(true);
    await supabase.from("reviews").insert({
      job_id: job.id,
      decision,
      notes: notes || null,
      reviewer: reviewer || "anonymous",
    });
    setDeciding(false);
    onDecision();
  };

  const collectorH = handoffs.find((h) => h.from_stage === "collecting");
  const writerH    = handoffs.find((h) => h.from_stage === "writing");
  const reviewerH  = handoffs.find((h) => h.from_stage === "review");

  const cStatus = deriveStageStatus("collecting", job, !!collectorH);
  const wStatus = deriveStageStatus("writing",    job, !!writerH);
  const rStatus = deriveStageStatus("review",     job, !!reviewerH);

  const totalTokens = handoffs.reduce((s, h) => s + (h.tokens_used ?? 0), 0);
  const writerArtifact = writerH ? (writerH.artifact as unknown as WriterArtifact) : null;

  return (
    <div>
      {/* Token count + download */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "0.875rem",
        marginBottom: "1.25rem",
        flexWrap: "wrap",
      }}>
        {totalTokens > 0 && (
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            ⚡ {totalTokens.toLocaleString()} tokens used across all stages
          </span>
        )}
        {job.status === "published" && writerArtifact?.brief_markdown && (
          <button
            onClick={() => downloadMarkdown(job.topic, writerArtifact!.brief_markdown)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.3rem 0.75rem",
              borderRadius: "6px",
              background: "var(--green-light)",
              border: "1.5px solid var(--green)",
              color: "var(--green)",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: "pointer",
              marginLeft: "auto",
              letterSpacing: "-0.01em",
            }}
          >
            ↓ Download brief (.md)
          </button>
        )}
      </div>

      {/* ── Stages ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>

        {/* Collector */}
        <StageBlock
          icon="◈"
          label="COLLECTOR"
          agent="collector"
          stageColor="var(--blue)"
          stageLightColor="var(--blue-light)"
          status={cStatus}
          tokensUsed={collectorH?.tokens_used}
        >
          {cStatus === "complete" && collectorH
            ? <CollectorOutput handoff={collectorH} topic={job.topic} />
            : cStatus === "active"
            ? <ActiveThinking steps={[
                `Searching Google News RSS for "${job.topic}"`,
                "Querying Hacker News Algolia API",
                "Scoring candidates for relevance",
                "Selecting top sources",
              ]} />
            : cStatus === "failed" ? <FailedNote /> : null}
        </StageBlock>

        <StageConnector lit={wStatus !== "pending"} />

        {/* Writer */}
        <StageBlock
          icon="✦"
          label="WRITER"
          agent="writer"
          stageColor="var(--purple)"
          stageLightColor="var(--purple-light)"
          status={wStatus}
          tokensUsed={writerH?.tokens_used}
        >
          {wStatus === "complete" && writerH
            ? <WriterOutput handoff={writerH} topic={job.topic} />
            : wStatus === "active"
            ? <ActiveThinking steps={[
                "Reading sources from Collector",
                "Drafting research brief",
                "Adding citations",
              ]} />
            : wStatus === "failed" ? <FailedNote /> : null}
        </StageBlock>

        <StageConnector lit={rStatus !== "pending"} />

        {/* Reviewer */}
        <StageBlock
          icon="◉"
          label="REVIEWER"
          agent="reviewer"
          stageColor="var(--amber)"
          stageLightColor="var(--amber-light)"
          status={rStatus}
          tokensUsed={reviewerH?.tokens_used}
        >
          {rStatus === "complete" && reviewerH
            ? <ReviewerOutput handoff={reviewerH} />
            : rStatus === "active"
            ? <ActiveThinking steps={[
                "Checking citation support",
                "Evaluating topic coverage",
                "Verifying factuality",
                "Computing confidence score",
              ]} />
            : rStatus === "failed" ? <FailedNote /> : null}
        </StageBlock>

        {/* Human review */}
        {job.status === "escalated" && reviews.length === 0 && (
          <>
            <StageConnector lit />
            <HumanReviewPanel
              reviewer={reviewer}
              notes={notes}
              deciding={deciding}
              onReviewerChange={setReviewer}
              onNotesChange={setNotes}
              onDecide={decide}
            />
          </>
        )}

        {/* Past decisions */}
        {reviews.length > 0 && (
          <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {reviews.map((r) => (
              <div key={r.id} style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.5rem 0.875rem",
                borderRadius: "8px",
                background: r.decision === "approve" ? "var(--green-light)" : "var(--red-light)",
                border: `1.5px solid ${r.decision === "approve" ? "var(--green)" : "var(--red)"}`,
                fontSize: "0.8rem",
              }}>
                <span style={{ fontWeight: 700, color: r.decision === "approve" ? "var(--green)" : "var(--red)" }}>
                  {r.decision === "approve" ? "✓ Approved & Published" : "✗ Rejected"}
                </span>
                {r.reviewer && (
                  <span style={{ color: "var(--text-muted)" }}>by {r.reviewer}</span>
                )}
                {r.notes && (
                  <span style={{ color: "var(--text-2)" }}>— {r.notes}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Event log */}
      <EventLog events={events} />
    </div>
  );
}

// ── Stage block ───────────────────────────────────────────────────────────────

function StageBlock({
  icon, label, agent, stageColor, stageLightColor, status, tokensUsed, children,
}: {
  icon: string;
  label: string;
  agent: string;
  stageColor: string;
  stageLightColor: string;
  status: StageStatus;
  tokensUsed?: number | null;
  children?: React.ReactNode;
}) {
  const borderColor = {
    pending:  "var(--border)",
    active:   stageColor,
    complete: "var(--border)",
    failed:   "var(--red)",
  }[status];

  const headerBg = {
    pending:  "var(--surface-2)",
    active:   stageLightColor,
    complete: "var(--surface-2)",
    failed:   "var(--red-light)",
  }[status];

  const iconColor = {
    pending:  "var(--text-muted)",
    active:   stageColor,
    complete: "var(--green)",
    failed:   "var(--red)",
  }[status];

  const statusText = {
    pending:  "waiting",
    active:   "running",
    complete: "done",
    failed:   "failed",
  }[status];

  const statusColor = {
    pending:  "var(--text-muted)",
    active:   stageColor,
    complete: "var(--green)",
    failed:   "var(--red)",
  }[status];

  return (
    <div style={{
      border: `1.5px solid ${borderColor}`,
      borderRadius: "10px",
      overflow: "hidden",
      background: "var(--surface)",
    }}>
      {/* Header */}
      <div style={{
        padding: "0.625rem 0.875rem",
        background: headerBg,
        borderBottom: children ? `1px solid var(--border)` : "none",
        display: "flex",
        alignItems: "center",
        gap: "0.625rem",
      }}>
        <span style={{ color: iconColor, fontSize: "0.9rem", flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontSize: "0.7rem",
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: status === "pending" ? "var(--text-muted)" : "var(--text)",
        }}>
          {label}
        </span>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "auto" }}>
          {agent}
        </span>
        {tokensUsed != null && tokensUsed > 0 && (
          <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
            {tokensUsed} tok
          </span>
        )}
        <span style={{
          fontSize: "0.68rem",
          fontWeight: 600,
          color: statusColor,
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
        }}>
          <span style={{
            display: "inline-block",
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: statusColor,
            ...(status === "active" ? { boxShadow: `0 0 0 2px ${stageColor}30` } : {}),
          }} />
          {statusText}
        </span>
      </div>

      {/* Content */}
      {children && (
        <div style={{ padding: "0.875rem 1rem" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function StageConnector({ lit }: { lit: boolean }) {
  return (
    <div style={{
      display: "flex",
      paddingLeft: "1.3rem",
      height: "1.25rem",
      alignItems: "stretch",
    }}>
      <div style={{
        width: "1.5px",
        background: lit ? "var(--border-2)" : "var(--border)",
        transition: "background 0.3s",
        borderRadius: "1px",
      }} />
    </div>
  );
}

function FailedNote() {
  return (
    <p style={{
      fontSize: "0.8rem",
      color: "var(--red)",
      fontFamily: "var(--font-mono, monospace)",
      margin: 0,
    }}>
      ▸ Stage failed — check the event log below.
    </p>
  );
}

// ── Thought stream ────────────────────────────────────────────────────────────

function ThoughtStream({ lines }: {
  lines: { text: string; tone?: "normal" | "pass" | "fail" | "info" }[];
}) {
  const color = (tone?: string) => ({
    pass:   "var(--green)",
    fail:   "var(--red)",
    info:   "var(--text)",
    normal: "var(--text-2)",
  })[tone ?? "normal"] ?? "var(--text-2)";

  return (
    <div style={{
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "0.78rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.25rem",
      marginBottom: "0.875rem",
    }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
          <span style={{ color: "var(--accent)", flexShrink: 0, fontSize: "0.68rem" }}>▸</span>
          <span style={{ color: color(line.tone) }}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Active thinking ───────────────────────────────────────────────────────────

function ActiveThinking({ steps }: { steps: string[] }) {
  return (
    <div style={{
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "0.78rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.28rem",
    }}>
      {steps.map((step, i) => (
        <div key={i} className="thought" style={{
          animationDelay: `${i * 0.08}s`,
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          color: "var(--text-muted)",
        }}>
          <span style={{ color: "var(--accent)", flexShrink: 0, fontSize: "0.68rem" }}>▸</span>
          <span>{step}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginTop: "0.1rem" }}>
        <span style={{ color: "var(--accent)", fontSize: "0.68rem" }}>▸</span>
        <span className="cursor" />
      </div>
    </div>
  );
}

// ── Collector output ──────────────────────────────────────────────────────────

function CollectorOutput({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  const lines = [
    { text: `Searched Google News RSS for "${topic}"` },
    { text: "Queried Hacker News Algolia API" },
    { text: a.notes || "Scored candidates for relevance" },
    { text: `Selected ${a.count ?? 0} source${a.count !== 1 ? "s" : ""} for Writer`, tone: "info" as const },
  ];

  return (
    <>
      <ThoughtStream lines={lines} />
      {a.sources?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {a.sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                padding: "0.625rem 0.875rem",
                borderRadius: "8px",
                background: "var(--surface-2)",
                border: "1.5px solid var(--border)",
                textDecoration: "none",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
            >
              <div style={{
                fontSize: "0.82rem",
                fontWeight: 600,
                color: "var(--accent)",
                marginBottom: s.snippet ? "0.2rem" : 0,
                lineHeight: 1.4,
              }}>
                {s.title || s.url}
              </div>
              {s.snippet && (
                <div style={{
                  fontSize: "0.75rem",
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}>
                  {s.snippet.slice(0, 200)}{s.snippet.length > 200 ? "…" : ""}
                </div>
              )}
              <div style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginTop: "0.25rem" }}>
                {s.source}
                {s.published ? ` · ${new Date(s.published).toLocaleDateString()}` : ""}
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ── Writer output ─────────────────────────────────────────────────────────────

function WriterOutput({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as WriterArtifact;
  const lines = [
    { text: "Read sources from Collector" },
    { text: `Drafted "${a.title || "Research Brief"}"` },
    {
      text: `${a.word_count ?? "—"} words · ${a.citations?.length ?? 0} citation${a.citations?.length !== 1 ? "s" : ""}`,
      tone: "info" as const,
    },
  ];

  return (
    <>
      <ThoughtStream lines={lines} />
      {a.brief_markdown && (
        <div style={{
          padding: "1.25rem 1.375rem",
          background: "var(--surface-2)",
          borderRadius: "8px",
          border: "1.5px solid var(--border)",
        }}>
          <div className="brief-content">
            <ReactMarkdown>{a.brief_markdown}</ReactMarkdown>
          </div>
        </div>
      )}
    </>
  );
}

// ── Reviewer output ───────────────────────────────────────────────────────────

function ReviewerOutput({ handoff }: { handoff: Handoff }) {
  const a = handoff.artifact as unknown as ReviewerArtifact;
  const conf = (a.confidence ?? 0) * 100;
  const passed = a.verdict !== "escalate" && conf >= 70;

  const checkLabels: Record<string, string> = {
    citations_supported: "Citation support",
    coverage:            "Topic coverage",
    factuality:          "Factuality",
  };

  const lines = [
    ...(a.checks
      ? Object.entries(a.checks).map(([k, v]) => ({
          text: `${checkLabels[k] || k}: ${v ? "PASS" : "FAIL"}`,
          tone: (v ? "pass" : "fail") as "pass" | "fail",
        }))
      : []),
    { text: `Confidence: ${conf.toFixed(0)}%`, tone: "info" as const },
    { text: `Verdict: ${(a.verdict ?? "unknown").toUpperCase()}`, tone: (passed ? "pass" : "fail") as "pass" | "fail" },
  ];

  return (
    <>
      <ThoughtStream lines={lines} />

      {/* Confidence bar */}
      <div style={{ marginBottom: "0.875rem" }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "0.35rem",
          fontSize: "0.75rem",
        }}>
          <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Confidence</span>
          <span style={{ fontWeight: 700, color: passed ? "var(--green)" : "var(--orange)" }}>
            {conf.toFixed(0)}%
          </span>
        </div>
        <div style={{
          height: "5px",
          borderRadius: "3px",
          background: "var(--border)",
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${Math.min(conf, 100)}%`,
            background: passed ? "var(--green)" : "var(--orange)",
            borderRadius: "3px",
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        padding: "0.75rem 1rem",
        borderRadius: "8px",
        background: passed ? "var(--green-light)" : "var(--orange-light)",
        border: `1.5px solid ${passed ? "var(--green)" : "var(--orange)"}`,
      }}>
        <div style={{
          fontSize: "0.83rem",
          fontWeight: 700,
          color: passed ? "var(--green)" : "var(--orange)",
          marginBottom: a.reasons?.length ? "0.375rem" : 0,
        }}>
          {passed ? "✓ Passed — brief is being published" : "⚠ Escalated for human review"}
        </div>
        {a.reasons?.map((r, i) => (
          <div key={i} style={{ fontSize: "0.78rem", color: "var(--text-2)", marginTop: "0.15rem" }}>
            {r}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Human review panel ────────────────────────────────────────────────────────

function HumanReviewPanel({
  reviewer, notes, deciding,
  onReviewerChange, onNotesChange, onDecide,
}: {
  reviewer: string;
  notes: string;
  deciding: boolean;
  onReviewerChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onDecide: (d: "approve" | "reject") => void;
}) {
  const input: React.CSSProperties = {
    width: "100%",
    background: "var(--surface)",
    border: "1.5px solid var(--border-2)",
    borderRadius: "7px",
    padding: "0.45rem 0.75rem",
    fontSize: "0.82rem",
    color: "var(--text)",
    outline: "none",
  };

  return (
    <div style={{
      border: "1.5px solid var(--orange)",
      borderRadius: "10px",
      background: "var(--orange-light)",
      padding: "1rem",
    }}>
      <p style={{
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: "var(--orange)",
        marginBottom: "0.5rem",
      }}>
        ⚠ HUMAN REVIEW REQUIRED
      </p>
      <p style={{ fontSize: "0.82rem", color: "var(--text-2)", marginBottom: "0.875rem" }}>
        The Reviewer escalated this brief. Read the draft above and decide.
      </p>
      <input
        type="text"
        placeholder="Your name (optional)"
        value={reviewer}
        onChange={(e) => onReviewerChange(e.target.value)}
        style={{ ...input, marginBottom: "0.5rem" }}
      />
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        rows={2}
        style={{ ...input, resize: "none", marginBottom: "0.75rem", fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={() => onDecide("approve")}
          disabled={deciding}
          style={{
            flex: 1,
            padding: "0.55rem",
            borderRadius: "7px",
            background: "var(--green)",
            color: "#fff",
            border: "none",
            fontSize: "0.83rem",
            fontWeight: 700,
            cursor: deciding ? "default" : "pointer",
            opacity: deciding ? 0.5 : 1,
            letterSpacing: "-0.01em",
          }}
        >
          ✓ Approve &amp; Publish
        </button>
        <button
          onClick={() => onDecide("reject")}
          disabled={deciding}
          style={{
            flex: 1,
            padding: "0.55rem",
            borderRadius: "7px",
            background: "var(--surface)",
            color: "var(--red)",
            border: "1.5px solid var(--red)",
            fontSize: "0.83rem",
            fontWeight: 700,
            cursor: deciding ? "default" : "pointer",
            opacity: deciding ? 0.5 : 1,
            letterSpacing: "-0.01em",
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────────

function EventLog({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const relevant = events.filter((e) => !(e.detail as Record<string, unknown>)?.heartbeat);
  if (relevant.length === 0) return null;

  const typeColor: Record<string, string> = {
    started:        "var(--blue)",
    retry:          "var(--amber)",
    throttled:      "var(--amber)",
    failed:         "var(--red)",
    escalated:      "var(--orange)",
    published:      "var(--green)",
    human_decision: "var(--purple)",
  };

  return (
    <div style={{ marginTop: "1.25rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: "0.75rem",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: 0,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        <span style={{
          display: "inline-block",
          transform: open ? "rotate(90deg)" : "rotate(0)",
          transition: "transform 0.15s",
        }}>
          ▶
        </span>
        Event log ({relevant.length})
      </button>
      {open && (
        <div style={{ marginTop: "0.625rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {relevant.map((ev) => (
            <div key={ev.id} style={{
              display: "flex",
              gap: "0.875rem",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.73rem",
              alignItems: "baseline",
            }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: "5rem" }}>
                {new Date(ev.created_at).toLocaleTimeString()}
              </span>
              <span style={{ color: typeColor[ev.type] ?? "var(--text-muted)", flexShrink: 0 }}>
                {ev.type}
              </span>
              {ev.stage && (
                <span style={{ color: "var(--text-muted)" }}>{ev.stage}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
