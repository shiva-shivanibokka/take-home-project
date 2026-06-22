"use client";

import { useEffect, useRef, useState } from "react";
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
  title: string; url: string; snippet: string; published: string; source: string;
}
interface CollectorArtifact {
  sources: Source[]; count: number; notes: string; tokens_used: number;
}
interface WriterArtifact {
  title: string; brief_markdown: string; citations: string[]; word_count: number;
}
interface ReviewerArtifact {
  confidence: number;
  checks: { citations_supported: boolean; coverage: boolean; factuality: boolean };
  verdict: "publish" | "escalate";
  reasons: string[];
}

type StageStatus = "pending" | "active" | "complete" | "failed";

// ── Stage status ──────────────────────────────────────────────────────────────

function deriveStatus(
  stage: "collecting" | "writing" | "review",
  job: Job,
  hasHandoff: boolean
): StageStatus {
  if (hasHandoff) return "complete";
  if (job.status === stage) return "active";
  if (job.status === "published" || job.status === "escalated") return "complete";
  const order = ["queued", "collecting", "writing", "review"];
  return order.indexOf(job.status) > order.indexOf(stage) ? "complete" : "pending";
}

// ── PDF download ──────────────────────────────────────────────────────────────

function downloadPDF(topic: string, briefEl: HTMLElement | null) {
  if (!briefEl) return;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${topic} — Research Brief</title>
  <style>
    body{font-family:Georgia,'Times New Roman',serif;max-width:680px;margin:52px auto;
         line-height:1.78;color:#111827;font-size:15px}
    h1{font-size:22px;font-weight:700;color:#030712;margin:0 0 10px;line-height:1.25}
    h2{font-size:17px;font-weight:600;color:#111827;border-bottom:1px solid #e5e7eb;
       padding-bottom:4px;margin:28px 0 10px}
    h3{font-size:15px;font-weight:600;color:#374151;margin:20px 0 6px}
    p{margin:0 0 16px;color:#374151}
    ul,ol{padding-left:22px;margin:8px 0 16px}
    li{margin:6px 0;color:#374151}
    a{color:#4F46E5}
    strong{font-weight:700;color:#111827}
    code{font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px}
    .footer{margin-top:48px;font-size:11px;color:#9CA3AF;border-top:1px solid #e5e7eb;padding-top:12px}
  </style>
</head>
<body>
  <h1>${topic}</h1>
  ${briefEl.innerHTML}
  <div class="footer">Research Desk &middot; Generated ${new Date().toLocaleDateString()} &middot; Multi-Agent Pipeline (Collector &rarr; Writer &rarr; Reviewer)</div>
</body>
</html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function PipelineView({ job, onDecision }: { job: Job; onDecision: () => void }) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [events,   setEvents]   = useState<Event[]>([]);
  const [reviews,  setReviews]  = useState<Review[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [notes,    setNotes]    = useState("");
  const [deciding, setDeciding] = useState(false);
  const briefRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHandoffs([]); setEvents([]); setReviews([]);

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
      .channel(`pv-${job.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoffs", filter: `job_id=eq.${job.id}` },
        (p) => setHandoffs((prev) => [...prev, p.new as Handoff])
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `job_id=eq.${job.id}` },
        (p) => setEvents((prev) => [...prev, p.new as Event])
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [job.id]);

  const decide = async (d: "approve" | "reject") => {
    setDeciding(true);
    await supabase.from("reviews").insert({
      job_id: job.id, decision: d,
      notes: notes || null, reviewer: reviewer || "anonymous",
    });
    setDeciding(false);
    onDecision();
  };

  const collectorH = handoffs.find((h) => h.from_stage === "collecting");
  const writerH    = handoffs.find((h) => h.from_stage === "writing");
  const reviewerH  = handoffs.find((h) => h.from_stage === "review");

  const cSt = deriveStatus("collecting", job, !!collectorH);
  const wSt = deriveStatus("writing",    job, !!writerH);
  const rSt = deriveStatus("review",     job, !!reviewerH);

  const totalTokens = handoffs.reduce((s, h) => s + (h.tokens_used ?? 0), 0);
  const writerArt = writerH ? (writerH.artifact as unknown as WriterArtifact) : null;

  return (
    <div>
      {/* Top bar: tokens + download */}
      <div style={{
        display: "flex",
        alignItems: "center",
        marginBottom: "1.125rem",
        gap: "0.75rem",
      }}>
        {totalTokens > 0 && (
          <span style={{ fontSize: "0.73rem", color: "var(--text-muted)" }}>
            ⚡ {totalTokens.toLocaleString()} tokens across {handoffs.length} handoff{handoffs.length !== 1 ? "s" : ""}
          </span>
        )}
        {(job.status === "published" || (job.status === "escalated" && reviews.length > 0)) && writerArt?.brief_markdown && (
          <button
            onClick={() => downloadPDF(job.topic, briefRef.current)}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.375rem",
              padding: "0.35rem 0.875rem",
              borderRadius: "7px",
              background: "var(--green-dim)",
              border: "1.5px solid var(--green)",
              color: "var(--green)",
              fontSize: "0.78rem",
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "-0.01em",
            }}
          >
            ↓ Save as PDF
          </button>
        )}
      </div>

      {/* ── Collector ── */}
      <StageBlock
        icon="◈" label="COLLECTOR" agent="collector"
        dotColor="#3B82F6" activeBg="#EFF6FF" activeBorder="#BFDBFE"
        status={cSt} tokensUsed={collectorH?.tokens_used}
      >
        {cSt === "complete" && collectorH
          ? <CollectorOutput handoff={collectorH} topic={job.topic} />
          : cSt === "active"
          ? <ActiveThinking steps={[
              `Searching Google News RSS for "${job.topic}"`,
              "Querying Hacker News Algolia API",
              "Scoring candidates for relevance with LLM",
              "Selecting top sources",
            ]} />
          : cSt === "failed" ? <FailNote /> : null}
      </StageBlock>

      {/* Handoff record: Collector → Writer */}
      {collectorH && (
        <HandoffRecord handoff={collectorH} />
      )}

      <StageConnector lit={wSt !== "pending"} />

      {/* ── Writer ── */}
      <StageBlock
        icon="✦" label="WRITER" agent="writer"
        dotColor="#8B5CF6" activeBg="#F5F3FF" activeBorder="#DDD6FE"
        status={wSt} tokensUsed={writerH?.tokens_used}
      >
        {wSt === "complete" && writerH
          ? <WriterOutput handoff={writerH} briefRef={briefRef} />
          : wSt === "active"
          ? <ActiveThinking steps={[
              "Reading sources from Collector",
              "Drafting research brief",
              "Writing with citations",
            ]} />
          : wSt === "failed" ? <FailNote /> : null}
      </StageBlock>

      {/* Handoff record: Writer → Reviewer */}
      {writerH && (
        <HandoffRecord handoff={writerH} />
      )}

      <StageConnector lit={rSt !== "pending"} />

      {/* ── Reviewer ── */}
      <StageBlock
        icon="◉" label="REVIEWER" agent="reviewer"
        dotColor="#F59E0B" activeBg="#FFFBEB" activeBorder="#FDE68A"
        status={rSt} tokensUsed={reviewerH?.tokens_used}
      >
        {rSt === "complete" && reviewerH
          ? <ReviewerOutput handoff={reviewerH} />
          : rSt === "active"
          ? <ActiveThinking steps={[
              "Checking citation support",
              "Evaluating topic coverage",
              "Verifying factuality",
              "Computing confidence score",
            ]} />
          : rSt === "failed" ? <FailNote /> : null}
      </StageBlock>

      {/* Human review */}
      {job.status === "escalated" && reviews.length === 0 && (
        <>
          <StageConnector lit />
          <HumanPanel reviewer={reviewer} notes={notes} deciding={deciding}
            onReviewer={setReviewer} onNotes={setNotes} onDecide={decide} />
        </>
      )}

      {/* Past decisions */}
      {reviews.length > 0 && (
        <div style={{ marginTop: "0.875rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {reviews.map((r) => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: "0.5rem",
              padding: "0.5rem 0.875rem", borderRadius: "8px", fontSize: "0.8rem",
              background: r.decision === "approve" ? "var(--green-dim)" : "var(--red-dim)",
              border: `1.5px solid ${r.decision === "approve" ? "var(--green)" : "var(--red)"}`,
            }}>
              <span style={{ fontWeight: 700, color: r.decision === "approve" ? "var(--green)" : "var(--red)" }}>
                {r.decision === "approve" ? "✓ Approved & Published" : "✗ Rejected"}
              </span>
              {r.reviewer && <span style={{ color: "var(--text-muted)" }}>by {r.reviewer}</span>}
              {r.notes && <span style={{ color: "var(--text-2)" }}>— {r.notes}</span>}
            </div>
          ))}
        </div>
      )}

      <EventLog events={events} />
    </div>
  );
}

// ── Shared stage block ────────────────────────────────────────────────────────

function StageBlock({ icon, label, agent, dotColor, activeBg, activeBorder, status, tokensUsed, children }: {
  icon: string; label: string; agent: string;
  dotColor: string; activeBg: string; activeBorder: string;
  status: StageStatus; tokensUsed?: number | null;
  children?: React.ReactNode;
}) {
  const borderColor = {
    pending: "var(--border)",
    active:  activeBorder,
    complete:"var(--border)",
    failed:  "var(--red)",
  }[status];

  const headerBg = {
    pending: "var(--surface-2)",
    active:  activeBg,
    complete:"var(--surface-2)",
    failed:  "var(--red-dim)",
  }[status];

  const iconColor = {
    pending: "var(--text-muted)",
    active:  dotColor,
    complete:"var(--green)",
    failed:  "var(--red)",
  }[status];

  const statusMeta = {
    pending:  { text: "waiting",  color: "var(--text-muted)" },
    active:   { text: "running",  color: dotColor },
    complete: { text: "done",     color: "var(--green)" },
    failed:   { text: "failed",   color: "var(--red)" },
  }[status];

  return (
    <div style={{
      border: `1.5px solid ${borderColor}`,
      borderRadius: "10px",
      overflow: "hidden",
      background: "var(--surface)",
    }}>
      <div style={{
        padding: "0.575rem 0.875rem",
        background: headerBg,
        borderBottom: children ? `1px solid ${borderColor}` : "none",
        display: "flex", alignItems: "center", gap: "0.625rem",
      }}>
        <span style={{ color: iconColor, fontSize: "0.9rem", flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em",
          color: status === "pending" ? "var(--text-muted)" : "var(--text)",
        }}>
          {label}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginLeft: "auto" }}>
          {agent}
        </span>
        {tokensUsed != null && tokensUsed > 0 && (
          <span style={{ fontSize: "0.67rem", color: "var(--text-muted)" }}>{tokensUsed} tok</span>
        )}
        <span style={{
          display: "flex", alignItems: "center", gap: "0.25rem",
          fontSize: "0.68rem", fontWeight: 600, color: statusMeta.color,
        }}>
          <span style={{
            display: "inline-block", width: "5px", height: "5px",
            borderRadius: "50%", background: statusMeta.color,
            ...(status === "active" ? { boxShadow: `0 0 0 2px ${dotColor}28` } : {}),
          }} />
          {statusMeta.text}
        </span>
      </div>
      {children && <div style={{ padding: "0.875rem 1rem" }}>{children}</div>}
    </div>
  );
}

function StageConnector({ lit }: { lit: boolean }) {
  return (
    <div style={{ display: "flex", paddingLeft: "1.3rem", height: "1.25rem", alignItems: "stretch" }}>
      <div style={{
        width: "1.5px", borderRadius: "1px",
        background: lit ? "var(--border-2)" : "var(--border)",
        transition: "background 0.4s",
      }} />
    </div>
  );
}

// ── Handoff record — the key architectural feature shown visually ──────────────

function HandoffRecord({ handoff }: { handoff: Handoff }) {
  let summary = "";
  if (handoff.from_stage === "collecting") {
    const a = handoff.artifact as unknown as CollectorArtifact;
    summary = `${a.count ?? 0} sources`;
  } else if (handoff.from_stage === "writing") {
    const a = handoff.artifact as unknown as WriterArtifact;
    summary = `${a.word_count ?? 0} words · ${a.citations?.length ?? 0} citations`;
  } else if (handoff.from_stage === "review") {
    const a = handoff.artifact as unknown as ReviewerArtifact;
    summary = `${((a.confidence ?? 0) * 100).toFixed(0)}% conf · ${a.verdict}`;
  }

  return (
    <div className="handoff-record" style={{
      display: "flex",
      alignItems: "center",
      gap: "0.5rem",
      margin: "0.4rem 0 0.1rem 1.3rem",
      padding: "0.375rem 0.75rem",
      background: "var(--accent-dim)",
      border: "1px dashed rgba(91,95,255,0.28)",
      borderRadius: "7px",
      fontSize: "0.73rem",
    }}>
      <span style={{
        fontFamily: "var(--font-mono, monospace)",
        color: "var(--accent)",
        fontWeight: 600,
        flexShrink: 0,
      }}>
        handoff
      </span>
      <span style={{ color: "var(--text-muted)" }}>
        {handoff.from_stage} → {handoff.to_stage}
      </span>
      {summary && (
        <>
          <span style={{ color: "var(--text-dim)" }}>·</span>
          <span style={{ color: "var(--text-2)", fontWeight: 500 }}>{summary}</span>
        </>
      )}
      <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>
        {new Date(handoff.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

// ── Active thinking ────────────────────────────────────────────────────────────

function ActiveThinking({ steps }: { steps: string[] }) {
  return (
    <div style={{
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "0.78rem",
      display: "flex", flexDirection: "column", gap: "0.28rem",
    }}>
      {steps.map((step, i) => (
        <div key={i} className="thought" style={{
          animationDelay: `${i * 0.08}s`,
          display: "flex", alignItems: "baseline", gap: "0.5rem",
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

function FailNote() {
  return (
    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--red)", fontFamily: "var(--font-mono, monospace)" }}>
      ▸ Stage failed — see the event log below.
    </p>
  );
}

// ── Thought stream (completed stage reasoning) ────────────────────────────────

function ThoughtStream({ lines }: {
  lines: { text: string; tone?: "normal" | "pass" | "fail" | "info" }[];
}) {
  const tc = (t?: string) => ({
    pass: "var(--green)", fail: "var(--red)",
    info: "var(--text)", normal: "var(--text-3)",
  })[t ?? "normal"] ?? "var(--text-3)";

  return (
    <div style={{
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "0.78rem",
      display: "flex", flexDirection: "column", gap: "0.25rem",
      marginBottom: "0.875rem",
    }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
          <span style={{ color: "var(--accent)", flexShrink: 0, fontSize: "0.68rem" }}>▸</span>
          <span style={{ color: tc(line.tone) }}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Collector output ──────────────────────────────────────────────────────────

function CollectorOutput({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  return (
    <>
      <ThoughtStream lines={[
        { text: `Searched Google News RSS for "${topic}"` },
        { text: "Queried Hacker News Algolia API" },
        { text: a.notes || "Scored candidates for relevance" },
        { text: `Selected ${a.count ?? 0} source${a.count !== 1 ? "s" : ""} for Writer`, tone: "info" },
      ]} />
      {a.sources?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
          {a.sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
              style={{
                display: "block",
                padding: "0.55rem 0.75rem", borderRadius: "8px",
                background: "var(--surface-2)", border: "1.5px solid var(--border)",
                textDecoration: "none",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
            >
              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--accent)", marginBottom: s.snippet ? "0.2rem" : 0 }}>
                {s.title || s.url}
              </div>
              {s.snippet && (
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {s.snippet.slice(0, 200)}{s.snippet.length > 200 ? "…" : ""}
                </div>
              )}
              <div style={{ fontSize: "0.67rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                {s.source}{s.published ? ` · ${new Date(s.published).toLocaleDateString()}` : ""}
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ── Writer output ─────────────────────────────────────────────────────────────

function WriterOutput({ handoff, briefRef }: { handoff: Handoff; briefRef: React.RefObject<HTMLDivElement> }) {
  const a = handoff.artifact as unknown as WriterArtifact;
  return (
    <>
      <ThoughtStream lines={[
        { text: "Read sources from Collector" },
        { text: `Drafted "${a.title || "Research Brief"}"` },
        { text: `${a.word_count ?? "—"} words · ${a.citations?.length ?? 0} citation${a.citations?.length !== 1 ? "s" : ""}`, tone: "info" },
      ]} />
      {a.brief_markdown && (
        <div style={{
          padding: "1.125rem 1.25rem", borderRadius: "8px",
          background: "var(--surface-2)", border: "1.5px solid var(--border)",
        }}>
          <div ref={briefRef} className="brief-content">
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

  return (
    <>
      <ThoughtStream lines={[
        ...(a.checks ? Object.entries(a.checks).map(([k, v]) => ({
          text: `${checkLabels[k] || k}: ${v ? "PASS" : "FAIL"}`,
          tone: (v ? "pass" : "fail") as "pass" | "fail",
        })) : []),
        { text: `Confidence score: ${conf.toFixed(0)}%`, tone: "info" },
        { text: `Verdict: ${(a.verdict ?? "unknown").toUpperCase()}`, tone: (passed ? "pass" : "fail") as "pass" | "fail" },
      ]} />

      {/* Confidence bar */}
      <div style={{ marginBottom: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem", fontSize: "0.73rem" }}>
          <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Confidence</span>
          <span style={{ fontWeight: 700, color: passed ? "var(--green)" : "var(--orange)" }}>{conf.toFixed(0)}%</span>
        </div>
        <div style={{ height: "5px", borderRadius: "3px", background: "var(--border)", overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: "3px",
            width: `${Math.min(conf, 100)}%`,
            background: passed ? "var(--green)" : "var(--orange)",
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        padding: "0.75rem 1rem", borderRadius: "8px",
        background: passed ? "var(--green-dim)" : "var(--orange-dim)",
        border: `1.5px solid ${passed ? "var(--green)" : "var(--orange)"}`,
      }}>
        <div style={{ fontSize: "0.83rem", fontWeight: 700, color: passed ? "var(--green)" : "var(--orange)", marginBottom: a.reasons?.length ? "0.375rem" : 0 }}>
          {passed ? "✓ Passed — brief is publishing" : "⚠ Escalated for human review"}
        </div>
        {a.reasons?.map((r, i) => (
          <div key={i} style={{ fontSize: "0.78rem", color: "var(--text-3)", marginTop: "0.15rem" }}>{r}</div>
        ))}
      </div>
    </>
  );
}

// ── Human review panel ────────────────────────────────────────────────────────

function HumanPanel({ reviewer, notes, deciding, onReviewer, onNotes, onDecide }: {
  reviewer: string; notes: string; deciding: boolean;
  onReviewer: (v: string) => void; onNotes: (v: string) => void;
  onDecide: (d: "approve" | "reject") => void;
}) {
  const inp: React.CSSProperties = {
    width: "100%", background: "var(--surface)",
    border: "1.5px solid var(--border-2)", borderRadius: "7px",
    padding: "0.42rem 0.7rem", fontSize: "0.82rem",
    color: "var(--text)", outline: "none",
  };
  return (
    <div style={{
      border: "1.5px solid var(--orange)", borderRadius: "10px",
      background: "var(--orange-dim)", padding: "0.875rem 1rem",
    }}>
      <p style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--orange)", margin: "0 0 0.5rem" }}>
        ⚠ HUMAN REVIEW REQUIRED
      </p>
      <p style={{ fontSize: "0.82rem", color: "var(--text-3)", margin: "0 0 0.75rem" }}>
        The Reviewer escalated this brief. Read the draft above and decide.
      </p>
      <input type="text" placeholder="Your name (optional)" value={reviewer}
        onChange={(e) => onReviewer(e.target.value)}
        style={{ ...inp, marginBottom: "0.5rem" }} />
      <textarea placeholder="Notes (optional)" value={notes}
        onChange={(e) => onNotes(e.target.value)} rows={2}
        style={{ ...inp, resize: "none", marginBottom: "0.625rem", fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button onClick={() => onDecide("approve")} disabled={deciding}
          style={{
            flex: 1, padding: "0.55rem", borderRadius: "7px",
            background: "var(--green)", color: "#fff", border: "none",
            fontSize: "0.83rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✓ Approve &amp; Publish
        </button>
        <button onClick={() => onDecide("reject")} disabled={deciding}
          style={{
            flex: 1, padding: "0.55rem", borderRadius: "7px",
            background: "var(--surface)", color: "var(--red)",
            border: "1.5px solid var(--red)",
            fontSize: "0.83rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✗ Reject
        </button>
      </div>
    </div>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────────

function EventLog({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const relevant = events.filter((e) => !e.detail?.heartbeat);
  if (relevant.length === 0) return null;

  const tc: Record<string, string> = {
    started: "var(--blue)", retry: "var(--amber)", throttled: "var(--amber)",
    failed: "var(--red)", escalated: "var(--orange)", published: "var(--green)",
    human_decision: "var(--purple)",
  };

  return (
    <div style={{ marginTop: "1.25rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        background: "none", border: "none", color: "var(--text-muted)",
        fontSize: "0.73rem", cursor: "pointer", display: "flex",
        alignItems: "center", gap: "0.375rem", padding: 0,
        fontFamily: "var(--font-mono, monospace)",
      }}>
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>▶</span>
        Event log ({relevant.length})
      </button>
      {open && (
        <div style={{ marginTop: "0.625rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {relevant.map((ev) => (
            <div key={ev.id} style={{
              display: "flex", gap: "0.875rem",
              fontFamily: "var(--font-mono, monospace)", fontSize: "0.73rem",
            }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: "5rem" }}>
                {new Date(ev.created_at).toLocaleTimeString()}
              </span>
              <span style={{ color: tc[ev.type] ?? "var(--text-muted)", flexShrink: 0 }}>{ev.type}</span>
              {ev.stage && <span style={{ color: "var(--text-muted)" }}>{ev.stage}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
