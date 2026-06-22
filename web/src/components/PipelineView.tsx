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

// ── Stage status resolution ───────────────────────────────────────────────────

function stageStatus(
  stage: "collecting" | "writing" | "review",
  job: Job,
  hasHandoff: boolean
): StageStatus {
  if (hasHandoff) return "complete";
  if (job.status === stage) return "active";
  if (job.status === "published" || job.status === "escalated") return "complete";
  if (job.status === "failed") {
    const order = ["queued", "collecting", "writing", "review"];
    return order.indexOf(job.status) >= order.indexOf(stage) ? "failed" : "pending";
  }
  const order = ["queued", "collecting", "writing", "review"];
  return order.indexOf(job.status) > order.indexOf(stage) ? "complete" : "pending";
}

// ── Root component ────────────────────────────────────────────────────────────

export function PipelineView({ job, onDecision }: { job: Job; onDecision: () => void }) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
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
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "handoffs", filter: `job_id=eq.${job.id}` },
        (p) => setHandoffs((prev) => [...prev, p.new as Handoff])
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "events", filter: `job_id=eq.${job.id}` },
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

  const cStatus = stageStatus("collecting", job, !!collectorH);
  const wStatus = stageStatus("writing",    job, !!writerH);
  const rStatus = stageStatus("review",     job, !!reviewerH);

  const totalTokens = handoffs.reduce((s, h) => s + (h.tokens_used ?? 0), 0);

  return (
    <div style={{ maxWidth: "780px" }}>
      {/* ── Job header ── */}
      <div style={{ marginBottom: "1.75rem" }}>
        <h2 style={{
          fontFamily: "var(--font-space, sans-serif)",
          fontSize: "1.2rem",
          fontWeight: 700,
          color: "var(--text)",
          lineHeight: 1.3,
          marginBottom: "0.625rem",
        }}>
          {job.topic}
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", flexWrap: "wrap" }}>
          <StatusBadge status={job.status} />
          {job.attempts > 0 && (
            <span style={{ fontSize: "0.73rem", color: "var(--amber)" }}>
              ↺ {job.attempts} {job.attempts === 1 ? "retry" : "retries"}
            </span>
          )}
          {totalTokens > 0 && (
            <span style={{ fontSize: "0.73rem", color: "var(--text-muted)" }}>
              ⚡ {totalTokens.toLocaleString()} tokens
            </span>
          )}
          <span style={{ fontSize: "0.73rem", color: "var(--text-muted)", marginLeft: "auto" }}>
            {new Date(job.created_at).toLocaleString()}
          </span>
        </div>
      </div>

      {/* ── Pipeline ── */}
      <div>
        {/* Collector */}
        <StageBlock label="COLLECTOR" icon="◈" agent="collector" status={cStatus}>
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
        <StageBlock label="WRITER" icon="✦" agent="writer" status={wStatus}>
          {wStatus === "complete" && writerH
            ? <WriterOutput handoff={writerH} />
            : wStatus === "active"
            ? <ActiveThinking steps={[
                "Reading sources from Collector",
                "Drafting research brief",
                "Writing citations",
              ]} />
            : wStatus === "failed" ? <FailedNote /> : null}
        </StageBlock>

        <StageConnector lit={rStatus !== "pending"} />

        {/* Reviewer */}
        <StageBlock label="REVIEWER" icon="◉" agent="reviewer" status={rStatus}>
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
          <div style={{ marginTop: "1rem" }}>
            {reviews.map((r) => (
              <div key={r.id} style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                borderRadius: "6px",
                background: r.decision === "approve"
                  ? "rgba(46,196,122,0.07)" : "rgba(224,82,82,0.07)",
                border: `1px solid ${r.decision === "approve"
                  ? "rgba(46,196,122,0.2)" : "rgba(224,82,82,0.2)"}`,
                fontSize: "0.78rem",
              }}>
                <span style={{ color: r.decision === "approve" ? "var(--green)" : "var(--red)" }}>
                  {r.decision === "approve" ? "✓" : "✗"}
                </span>
                <span style={{
                  fontWeight: 600,
                  color: r.decision === "approve" ? "var(--green)" : "var(--red)",
                }}>
                  {r.decision === "approve" ? "Approved & Published" : "Rejected"}
                </span>
                {r.reviewer && (
                  <span style={{ color: "var(--text-muted)" }}>by {r.reviewer}</span>
                )}
                {r.notes && (
                  <span style={{ color: "var(--text-muted)" }}>— {r.notes}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Event log ── */}
      <EventLog events={events} />
    </div>
  );
}

// ── Stage block ───────────────────────────────────────────────────────────────

function StageBlock({
  label, icon, agent, status, children,
}: {
  label: string;
  icon: string;
  agent: string;
  status: StageStatus;
  children?: React.ReactNode;
}) {
  const borderColor = {
    pending:  "var(--border)",
    active:   "var(--accent)",
    complete: "var(--border-2)",
    failed:   "var(--red)",
  }[status];

  const iconColor = {
    pending:  "var(--text-muted)",
    active:   "var(--accent)",
    complete: "var(--green)",
    failed:   "var(--red)",
  }[status];

  const headerBg = {
    pending:  "transparent",
    active:   "rgba(75,158,245,0.04)",
    complete: "rgba(255,255,255,0.015)",
    failed:   "rgba(224,82,82,0.04)",
  }[status];

  return (
    <div
      className={status === "active" ? "stage-active" : undefined}
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      {/* Header row */}
      <div style={{
        padding: "0.6rem 0.875rem",
        background: headerBg,
        borderBottom: children ? `1px solid ${borderColor}` : "none",
        display: "flex",
        alignItems: "center",
        gap: "0.625rem",
      }}>
        <span style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.95rem",
          color: iconColor,
          lineHeight: 1,
        }}>
          {icon}
        </span>
        <span style={{
          fontFamily: "var(--font-space, sans-serif)",
          fontSize: "0.72rem",
          fontWeight: 700,
          letterSpacing: "0.12em",
          color: status === "pending" ? "var(--text-muted)" : "var(--text)",
        }}>
          {label}
        </span>
        <span style={{
          fontSize: "0.68rem",
          color: "var(--text-muted)",
          marginLeft: "auto",
        }}>
          {agent}
        </span>
        <StatusDot status={status} />
      </div>

      {/* Content */}
      {children && (
        <div style={{ padding: "0.875rem" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: StageStatus }) {
  const color = {
    pending:  "var(--text-muted)",
    active:   "var(--accent)",
    complete: "var(--green)",
    failed:   "var(--red)",
  }[status];
  const label = {
    pending:  "waiting",
    active:   "running",
    complete: "done",
    failed:   "failed",
  }[status];
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.68rem", color }}>
      <span style={{
        display: "inline-block",
        width: "5px",
        height: "5px",
        borderRadius: "50%",
        background: color,
        ...(status === "active" ? { boxShadow: `0 0 4px ${color}` } : {}),
      }} />
      {label}
    </span>
  );
}

function StageConnector({ lit }: { lit: boolean }) {
  return (
    <div style={{
      display: "flex",
      paddingLeft: "1.35rem",
      height: "1.375rem",
      alignItems: "stretch",
    }}>
      <div style={{
        width: "1px",
        background: lit ? "var(--border-2)" : "var(--border)",
        transition: "background 0.3s",
      }} />
    </div>
  );
}

// ── Active "thinking" state ───────────────────────────────────────────────────

function ActiveThinking({ steps }: { steps: string[] }) {
  return (
    <div style={{
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "0.78rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.3rem",
    }}>
      {steps.map((step, i) => (
        <div key={i} className="thought" style={{
          animationDelay: `${i * 0.08}s`,
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          color: "var(--text-muted)",
        }}>
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>▸</span>
          <span>{step}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <span style={{ color: "var(--accent)" }}>▸</span>
        <span className="cursor" />
      </div>
    </div>
  );
}

function FailedNote() {
  return (
    <p style={{ fontSize: "0.78rem", color: "var(--red)", fontFamily: "var(--font-mono, monospace)" }}>
      ▸ Stage failed — check the event log below.
    </p>
  );
}

// ── ThoughtStream (completed stages) ─────────────────────────────────────────

function ThoughtStream({ lines }: { lines: { text: string; tone?: "normal" | "pass" | "fail" | "info" }[] }) {
  const toneColor = (tone?: string) => ({
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
      gap: "0.28rem",
      marginBottom: "0.875rem",
    }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
          <span style={{ color: "var(--accent)", flexShrink: 0, fontSize: "0.7rem" }}>▸</span>
          <span style={{ color: toneColor(line.tone) }}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Collector output ──────────────────────────────────────────────────────────

function CollectorOutput({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  const lines = [
    { text: `Searched Google News RSS for "${topic}"` },
    { text: `Queried Hacker News Algolia API` },
    { text: a.notes || `Scored candidates for relevance` },
    { text: `Selected ${a.count ?? 0} source${a.count !== 1 ? "s" : ""} for Writer`, tone: "info" as const },
    ...(handoff.tokens_used ? [{ text: `${handoff.tokens_used} tokens`, tone: "normal" as const }] : []),
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
                padding: "0.5rem 0.75rem",
                borderRadius: "6px",
                background: "rgba(255,255,255,0.02)",
                border: "1px solid var(--border)",
                textDecoration: "none",
              }}
            >
              <div style={{
                fontSize: "0.8rem",
                color: "var(--accent)",
                fontWeight: 500,
                marginBottom: s.snippet ? "0.2rem" : 0,
              }}>
                {s.title || s.url}
              </div>
              {s.snippet && (
                <div style={{
                  fontSize: "0.72rem",
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}>
                  {s.snippet.slice(0, 180)}{s.snippet.length > 180 ? "…" : ""}
                </div>
              )}
              <div style={{
                fontSize: "0.67rem",
                color: "var(--text-dim)",
                marginTop: "0.25rem",
              }}>
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

function WriterOutput({ handoff }: { handoff: Handoff }) {
  const a = handoff.artifact as unknown as WriterArtifact;
  const lines = [
    { text: `Read sources from Collector` },
    { text: `Drafted "${a.title || "Research Brief"}"` },
    {
      text: `${a.word_count ?? "—"} words · ${a.citations?.length ?? 0} citation${a.citations?.length !== 1 ? "s" : ""}`,
      tone: "info" as const,
    },
    ...(handoff.tokens_used ? [{ text: `${handoff.tokens_used} tokens` }] : []),
  ];

  return (
    <>
      <ThoughtStream lines={lines} />
      {a.brief_markdown && (
        <div style={{
          padding: "1rem 1.125rem",
          background: "rgba(255,255,255,0.015)",
          borderRadius: "6px",
          border: "1px solid var(--border)",
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
    ...(handoff.tokens_used ? [{ text: `${handoff.tokens_used} tokens` }] : []),
  ];

  return (
    <>
      <ThoughtStream lines={lines} />

      {/* Confidence bar */}
      <div style={{ marginBottom: "0.875rem" }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "0.3rem",
          fontSize: "0.72rem",
        }}>
          <span style={{ color: "var(--text-muted)" }}>Confidence</span>
          <span style={{ fontWeight: 700, color: passed ? "var(--green)" : "var(--orange)" }}>
            {conf.toFixed(0)}%
          </span>
        </div>
        <div style={{
          height: "3px",
          borderRadius: "2px",
          background: "var(--border)",
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${Math.min(conf, 100)}%`,
            background: passed ? "var(--green)" : "var(--orange)",
            borderRadius: "2px",
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>

      {/* Verdict card */}
      <div style={{
        padding: "0.625rem 0.875rem",
        borderRadius: "6px",
        background: passed ? "rgba(46,196,122,0.07)" : "rgba(239,116,68,0.07)",
        border: `1px solid ${passed ? "rgba(46,196,122,0.22)" : "rgba(239,116,68,0.22)"}`,
      }}>
        <div style={{
          fontSize: "0.8rem",
          fontWeight: 600,
          color: passed ? "var(--green)" : "var(--orange)",
          marginBottom: a.reasons?.length ? "0.4rem" : 0,
        }}>
          {passed ? "✓ Passed review — publishing" : "⚠ Escalated for human review"}
        </div>
        {a.reasons?.map((r, i) => (
          <div key={i} style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
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
  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "0.4rem 0.625rem",
    fontSize: "0.78rem",
    color: "var(--text)",
    outline: "none",
  };

  return (
    <div style={{
      border: "1px solid rgba(239,116,68,0.35)",
      borderRadius: "8px",
      background: "rgba(239,116,68,0.04)",
      padding: "0.875rem",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "0.625rem",
      }}>
        <span>👤</span>
        <span style={{
          fontFamily: "var(--font-space, sans-serif)",
          fontSize: "0.72rem",
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: "var(--orange)",
        }}>
          HUMAN REVIEW REQUIRED
        </span>
      </div>
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
        The Reviewer agent escalated this brief. Read the draft above and decide.
      </p>
      <input
        type="text"
        placeholder="Your name (optional)"
        value={reviewer}
        onChange={(e) => onReviewerChange(e.target.value)}
        style={{ ...inputStyle, marginBottom: "0.5rem" }}
      />
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        rows={2}
        style={{ ...inputStyle, resize: "none", marginBottom: "0.625rem", fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={() => onDecide("approve")}
          disabled={deciding}
          style={{
            flex: 1,
            padding: "0.5rem",
            borderRadius: "6px",
            background: "var(--green)",
            color: "#fff",
            border: "none",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: deciding ? "default" : "pointer",
            opacity: deciding ? 0.5 : 1,
          }}
        >
          ✓ Approve &amp; Publish
        </button>
        <button
          onClick={() => onDecide("reject")}
          disabled={deciding}
          style={{
            flex: 1,
            padding: "0.5rem",
            borderRadius: "6px",
            background: "rgba(224,82,82,0.12)",
            color: "var(--red)",
            border: "1px solid rgba(224,82,82,0.3)",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: deciding ? "default" : "pointer",
            opacity: deciding ? 0.5 : 1,
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: JobStatus }) {
  const map: Record<string, { bg: string; color: string }> = {
    queued:     { bg: "rgba(255,255,255,0.05)", color: "var(--text-muted)" },
    collecting: { bg: "rgba(75,158,245,0.12)",  color: "var(--accent)" },
    writing:    { bg: "rgba(167,139,250,0.12)", color: "var(--purple)" },
    review:     { bg: "rgba(245,166,35,0.12)",  color: "var(--amber)" },
    published:  { bg: "rgba(46,196,122,0.12)",  color: "var(--green)" },
    escalated:  { bg: "rgba(239,116,68,0.12)",  color: "var(--orange)" },
    failed:     { bg: "rgba(224,82,82,0.12)",   color: "var(--red)" },
  };
  const s = map[status] ?? map.queued;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "0.18rem 0.6rem",
      borderRadius: "999px",
      background: s.bg,
      color: s.color,
      fontSize: "0.7rem",
      fontWeight: 600,
      letterSpacing: "0.04em",
    }}>
      {STAGE_LABELS[status]}
    </span>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────────

function EventLog({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const relevant = events.filter((e) => !(e.detail as any)?.heartbeat);
  if (relevant.length === 0) return null;

  const typeColor: Record<string, string> = {
    started:       "var(--accent)",
    retry:         "var(--amber)",
    throttled:     "var(--amber)",
    failed:        "var(--red)",
    escalated:     "var(--orange)",
    published:     "var(--green)",
    human_decision: "var(--purple)",
  };

  return (
    <div style={{ marginTop: "1.5rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: "0.73rem",
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
        }}>▶</span>
        Event log ({relevant.length})
      </button>
      {open && (
        <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
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
