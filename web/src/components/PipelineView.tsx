"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  supabase,
  type Job,
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

// ── PDF download ───────────────────────────────────────────────────────────────

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
    a{color:#4361EE}
    strong{font-weight:700;color:#111827}
    code{font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px}
    .footer{margin-top:48px;font-size:11px;color:#9CA3AF;border-top:1px solid #e2e8f0;padding-top:12px}
  </style>
</head>
<body>
  <h1>${topic}</h1>
  ${briefEl.innerHTML}
  <div class="footer">Research Desk · Generated ${new Date().toLocaleDateString()} · Multi-Agent Pipeline (Collector → Writer → Reviewer)</div>
</body>
</html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function PipelineView({ job, onDecision }: { job: Job; onDecision: () => void }) {
  const [handoffs,  setHandoffs]  = useState<Handoff[]>([]);
  const [events,    setEvents]    = useState<Event[]>([]);
  const [reviews,   setReviews]   = useState<Review[]>([]);
  const [activeTab, setActiveTab] = useState<"collector" | "writer" | "reviewer">("collector");
  const [reviewer,  setReviewer]  = useState("");
  const [notes,     setNotes]     = useState("");
  const [deciding,  setDeciding]  = useState(false);
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

  // Auto-advance tab to the furthest completed stage
  useEffect(() => {
    const collectorH = handoffs.find((h) => h.from_stage === "collecting");
    const writerH    = handoffs.find((h) => h.from_stage === "writing");
    const reviewerH  = handoffs.find((h) => h.from_stage === "review");
    if (reviewerH) setActiveTab("reviewer");
    else if (writerH) setActiveTab("writer");
    else if (collectorH) setActiveTab("collector");
  }, [handoffs]);

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
  const writerArt   = writerH ? (writerH.artifact as unknown as WriterArtifact) : null;

  return (
    <div style={{ display: "flex", gap: "1.75rem", minHeight: "100%", alignItems: "flex-start" }}>

      {/* ── LEFT: Stage tracker (fixed width) ─────────────────── */}
      <div style={{ width: "300px", flexShrink: 0 }}>

        {/* Token count */}
        {totalTokens > 0 && (
          <p style={{
            margin: "0 0 1rem", fontSize: "0.73rem", color: "var(--text-muted)",
            fontFamily: "var(--font-mono, monospace)",
          }}>
            ⚡ {totalTokens.toLocaleString()} tokens · {handoffs.length} handoff{handoffs.length !== 1 ? "s" : ""}
          </p>
        )}

        {/* Stage 1: Collector */}
        <StageRow
          icon="◈" label="Collector" status={cSt}
          dotColor="#4361EE" activeBg="#EEF2FF" activeBorder="#C7D2FE"
          tokens={collectorH?.tokens_used}
          isActive={activeTab === "collector"}
          onClick={() => setActiveTab("collector")}
        />

        {/* Handoff: collector → writer */}
        {collectorH && <HandoffPill handoff={collectorH} />}
        <StageConnector lit={wSt !== "pending"} />

        {/* Stage 2: Writer */}
        <StageRow
          icon="✦" label="Writer" status={wSt}
          dotColor="#8B5CF6" activeBg="#F5F3FF" activeBorder="#DDD6FE"
          tokens={writerH?.tokens_used}
          isActive={activeTab === "writer"}
          onClick={() => setActiveTab("writer")}
        />

        {/* Handoff: writer → reviewer */}
        {writerH && <HandoffPill handoff={writerH} />}
        <StageConnector lit={rSt !== "pending"} />

        {/* Stage 3: Reviewer */}
        <StageRow
          icon="◉" label="Reviewer" status={rSt}
          dotColor="#F59E0B" activeBg="#FFFBEB" activeBorder="#FDE68A"
          tokens={reviewerH?.tokens_used}
          isActive={activeTab === "reviewer"}
          onClick={() => setActiveTab("reviewer")}
        />

        {/* Past decisions */}
        {reviews.map((r) => (
          <div key={r.id} style={{
            marginTop: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem",
            padding: "0.5rem 0.75rem", borderRadius: "8px", fontSize: "0.78rem",
            background: r.decision === "approve" ? "var(--green-dim)" : "var(--red-dim)",
            border: `1.5px solid ${r.decision === "approve" ? "var(--green)" : "var(--red)"}`,
          }}>
            <span style={{ fontWeight: 700, color: r.decision === "approve" ? "var(--green)" : "var(--red)" }}>
              {r.decision === "approve" ? "✓ Approved" : "✗ Rejected"}
            </span>
            {r.reviewer && <span style={{ color: "var(--text-muted)" }}>by {r.reviewer}</span>}
          </div>
        ))}

        {/* Event log */}
        <EventLog events={events} />
      </div>

      {/* ── RIGHT: Output pane (flex 1) ────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* Tab strip */}
        <div style={{
          display: "flex", gap: "0.25rem", marginBottom: "1.25rem",
          borderBottom: "1px solid var(--border)", paddingBottom: "0",
        }}>
          {([
            { key: "collector" as const, label: "Sources",  status: cSt, color: "#4361EE" },
            { key: "writer"    as const, label: "Brief",    status: wSt, color: "#8B5CF6" },
            { key: "reviewer"  as const, label: "Review",   status: rSt, color: "#F59E0B" },
          ] as const).map((t) => {
            const enabled = t.status !== "pending";
            const active  = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => enabled && setActiveTab(t.key)}
                style={{
                  background: "none", border: "none",
                  borderBottom: active ? `2px solid ${t.color}` : "2px solid transparent",
                  padding: "0.5rem 0.875rem", marginBottom: "-1px",
                  fontSize: "0.82rem", fontWeight: active ? 700 : 500,
                  color: !enabled ? "var(--text-dim)" : active ? t.color : "var(--text-muted)",
                  cursor: enabled ? "pointer" : "default",
                  display: "flex", alignItems: "center", gap: "0.35rem",
                  transition: "color 0.15s, border-color 0.15s",
                }}
              >
                {t.status === "active" && (
                  <span className="dot-pulse" style={{
                    display: "inline-block", width: "5px", height: "5px",
                    borderRadius: "50%", background: t.color,
                  }} />
                )}
                {t.status === "complete" && (
                  <span style={{ fontSize: "0.72rem", color: "var(--green)", fontWeight: 700 }}>✓</span>
                )}
                {t.label}
              </button>
            );
          })}

          {/* Download button lives in the tab bar when brief is ready */}
          {writerArt?.brief_markdown && (
            <button
              onClick={() => downloadPDF(job.topic, briefRef.current)}
              style={{
                marginLeft: "auto",
                display: "inline-flex", alignItems: "center", gap: "0.35rem",
                padding: "0.4rem 0.875rem", marginBottom: "0.375rem",
                borderRadius: "7px",
                background: "var(--green-dim)", border: "1.5px solid var(--green)",
                color: "var(--green)", fontSize: "0.78rem", fontWeight: 700,
                cursor: "pointer", letterSpacing: "-0.01em",
              }}
            >
              ↓ Save as PDF
            </button>
          )}
        </div>

        {/* Tab content */}
        {activeTab === "collector" && (
          cSt === "complete" && collectorH
            ? <CollectorOutput handoff={collectorH} topic={job.topic} />
            : cSt === "active"
            ? <ActivePanel label="Collector" steps={[
                `Searching Google News RSS for "${job.topic}"`,
                "Querying Hacker News Algolia API",
                "Scoring candidates for relevance with LLM",
                "Selecting top sources",
              ]} />
            : <PendingPanel label="Collector" />
        )}

        {activeTab === "writer" && (
          wSt === "complete" && writerH
            ? <WriterOutput handoff={writerH} briefRef={briefRef} />
            : wSt === "active"
            ? <ActivePanel label="Writer" steps={[
                "Reading sources from Collector",
                "Drafting research brief",
                "Adding citations",
              ]} />
            : <PendingPanel label="Writer" />
        )}

        {activeTab === "reviewer" && (
          <>
            {rSt === "complete" && reviewerH
              ? <ReviewerOutput handoff={reviewerH} />
              : rSt === "active"
              ? <ActivePanel label="Reviewer" steps={[
                  "Checking citation support",
                  "Evaluating topic coverage",
                  "Verifying factuality",
                  "Computing confidence score",
                ]} />
              : <PendingPanel label="Reviewer" />}

            {job.status === "escalated" && reviews.length === 0 && (
              <HumanPanel reviewer={reviewer} notes={notes} deciding={deciding}
                onReviewer={setReviewer} onNotes={setNotes} onDecide={decide} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Stage row (left column) ────────────────────────────────────────────────────

function StageRow({ icon, label, status, dotColor, activeBg, activeBorder, tokens, isActive, onClick }: {
  icon: string; label: string; status: StageStatus;
  dotColor: string; activeBg: string; activeBorder: string;
  tokens?: number | null; isActive: boolean; onClick: () => void;
}) {
  const statusColor = { pending: "var(--text-muted)", active: dotColor, complete: "var(--green)", failed: "var(--red)" }[status];
  const statusText  = { pending: "waiting", active: "running", complete: "done", failed: "failed" }[status];
  const clickable   = status !== "pending";

  return (
    <button
      onClick={() => clickable && onClick()}
      style={{
        width: "100%", textAlign: "left",
        background: isActive && clickable ? activeBg : "var(--surface)",
        border: `1.5px solid ${isActive && clickable ? activeBorder : "var(--border)"}`,
        borderRadius: "9px", padding: "0.7rem 0.875rem",
        cursor: clickable ? "pointer" : "default",
        display: "flex", alignItems: "center", gap: "0.625rem",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <span style={{ color: statusColor, fontSize: "0.9rem", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, fontSize: "0.82rem", fontWeight: 700, color: status === "pending" ? "var(--text-muted)" : "var(--text)" }}>
        {label}
      </span>
      {tokens != null && tokens > 0 && (
        <span style={{ fontSize: "0.67rem", color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}>
          {tokens}tok
        </span>
      )}
      <span style={{
        display: "flex", alignItems: "center", gap: "0.25rem",
        fontSize: "0.68rem", fontWeight: 600, color: statusColor, flexShrink: 0,
      }}>
        {status === "active" && (
          <span className="dot-pulse" style={{ display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: dotColor }} />
        )}
        {statusText}
      </span>
    </button>
  );
}

function StageConnector({ lit }: { lit: boolean }) {
  return (
    <div style={{ display: "flex", paddingLeft: "1.3rem", height: "1rem", alignItems: "stretch" }}>
      <div style={{
        width: "1.5px", borderRadius: "1px",
        background: lit ? "var(--border-2)" : "var(--border)",
        transition: "background 0.4s",
      }} />
    </div>
  );
}

// ── Handoff pill ───────────────────────────────────────────────────────────────

function HandoffPill({ handoff }: { handoff: Handoff }) {
  let summary = "";
  if (handoff.from_stage === "collecting") {
    const a = handoff.artifact as unknown as CollectorArtifact;
    summary = `${a.count ?? 0} sources`;
  } else if (handoff.from_stage === "writing") {
    const a = handoff.artifact as unknown as WriterArtifact;
    summary = `${a.word_count ?? 0} words`;
  } else if (handoff.from_stage === "review") {
    const a = handoff.artifact as unknown as ReviewerArtifact;
    summary = `${((a.confidence ?? 0) * 100).toFixed(0)}% confidence`;
  }

  return (
    <div className="handoff-record" style={{
      display: "flex", alignItems: "center", gap: "0.4rem",
      margin: "0.2rem 0 0.2rem 1.3rem",
      padding: "0.3rem 0.625rem",
      background: "var(--accent-dim)",
      border: "1px dashed rgba(67,97,238,0.3)",
      borderRadius: "6px", fontSize: "0.7rem",
    }}>
      <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--accent)", fontWeight: 600 }}>handoff</span>
      <span style={{ color: "var(--text-muted)" }}>{handoff.from_stage} → {handoff.to_stage}</span>
      {summary && <>
        <span style={{ color: "var(--text-dim)" }}>·</span>
        <span style={{ color: "var(--text-2)", fontWeight: 500 }}>{summary}</span>
      </>}
    </div>
  );
}

// ── Active / Pending panels ────────────────────────────────────────────────────

function ActivePanel({ label, steps }: { label: string; steps: string[] }) {
  return (
    <div style={{
      padding: "1.5rem",
      background: "var(--surface)", border: "1.5px solid var(--border)",
      borderRadius: "12px",
    }}>
      <p style={{ margin: "0 0 1rem", fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        {label.toUpperCase()} — RUNNING
      </p>
      <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        {steps.map((step, i) => (
          <div key={i} className="thought" style={{
            animationDelay: `${i * 0.08}s`, display: "flex", alignItems: "baseline", gap: "0.5rem", color: "var(--text-muted)",
          }}>
            <span style={{ color: "var(--accent)", flexShrink: 0, fontSize: "0.7rem" }}>▸</span>
            <span>{step}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginTop: "0.1rem" }}>
          <span style={{ color: "var(--accent)", fontSize: "0.7rem" }}>▸</span>
          <span className="cursor" />
        </div>
      </div>
    </div>
  );
}

function PendingPanel({ label }: { label: string }) {
  return (
    <div style={{
      padding: "2rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--surface-2)", border: "1.5px dashed var(--border)",
      borderRadius: "12px", color: "var(--text-dim)",
      fontSize: "0.83rem", fontStyle: "italic",
    }}>
      {label} hasn&apos;t started yet
    </div>
  );
}

// ── Collector output ───────────────────────────────────────────────────────────

function CollectorOutput({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: "0.5rem",
        marginBottom: "1rem", fontFamily: "var(--font-mono, monospace)", fontSize: "0.78rem",
      }}>
        <span style={{ color: "var(--green)", fontWeight: 700 }}>▸</span>
        <span style={{ color: "var(--text-muted)" }}>
          Found <strong style={{ color: "var(--text)" }}>{a.count ?? 0} sources</strong> for &quot;{topic}&quot;
        </span>
        {a.notes && <span style={{ color: "var(--text-dim)" }}>— {a.notes}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {a.sources?.map((s, i) => (
          <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
            style={{
              display: "block", padding: "0.875rem 1rem", borderRadius: "10px",
              background: "var(--surface)", border: "1.5px solid var(--border)",
              textDecoration: "none", transition: "border-color 0.15s, box-shadow 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "#4361EE";
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(67,97,238,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--accent)", marginBottom: s.snippet ? "0.3rem" : 0, lineHeight: 1.3 }}>
              {s.title || s.url}
            </div>
            {s.snippet && (
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
                {s.snippet.slice(0, 220)}{s.snippet.length > 220 ? "…" : ""}
              </div>
            )}
            <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.35rem" }}>
              {s.source}{s.published ? ` · ${new Date(s.published).toLocaleDateString()}` : ""}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ── Writer output ──────────────────────────────────────────────────────────────

function WriterOutput({ handoff, briefRef }: { handoff: Handoff; briefRef: React.RefObject<HTMLDivElement> }) {
  const a = handoff.artifact as unknown as WriterArtifact;
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: "0.5rem",
        marginBottom: "1rem", fontFamily: "var(--font-mono, monospace)", fontSize: "0.78rem",
      }}>
        <span style={{ color: "var(--green)", fontWeight: 700 }}>▸</span>
        <span style={{ color: "var(--text-muted)" }}>
          <strong style={{ color: "var(--text)" }}>{a.word_count ?? "—"} words</strong> · {a.citations?.length ?? 0} citations
        </span>
      </div>
      <div style={{
        padding: "1.5rem 1.75rem", borderRadius: "12px",
        background: "var(--surface)", border: "1.5px solid var(--border)",
        boxShadow: "0 1px 6px rgba(0,0,0,0.04)",
      }}>
        <div ref={briefRef} className="brief-content">
          <ReactMarkdown>{a.brief_markdown}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ── Reviewer output ────────────────────────────────────────────────────────────

function ReviewerOutput({ handoff }: { handoff: Handoff }) {
  const a     = handoff.artifact as unknown as ReviewerArtifact;
  const conf  = (a.confidence ?? 0) * 100;
  const passed = a.verdict !== "escalate" && conf >= 70;

  const checkLabels: Record<string, string> = {
    citations_supported: "Citations supported",
    coverage:            "Topic coverage",
    factuality:          "Factuality",
  };

  return (
    <div>
      {/* Confidence bar */}
      <div style={{
        padding: "1.25rem 1.5rem", borderRadius: "12px",
        background: "var(--surface)", border: "1.5px solid var(--border)",
        marginBottom: "1rem",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.625rem" }}>
          <span style={{ fontSize: "0.83rem", fontWeight: 600, color: "var(--text)" }}>Confidence score</span>
          <span style={{ fontSize: "1.25rem", fontWeight: 800, color: passed ? "var(--green)" : "var(--orange)" }}>
            {conf.toFixed(0)}%
          </span>
        </div>
        <div style={{ height: "6px", borderRadius: "4px", background: "var(--border)", overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: "4px",
            width: `${Math.min(conf, 100)}%`,
            background: passed ? "var(--green)" : "var(--orange)",
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>

      {/* Checks */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}>
        {a.checks && Object.entries(a.checks).map(([k, v]) => (
          <div key={k} style={{
            display: "flex", alignItems: "center", gap: "0.75rem",
            padding: "0.625rem 0.875rem", borderRadius: "8px",
            background: v ? "var(--green-dim)" : "var(--red-dim)",
            border: `1px solid ${v ? "var(--green)" : "var(--red)"}`,
          }}>
            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: v ? "var(--green)" : "var(--red)" }}>
              {v ? "✓" : "✗"}
            </span>
            <span style={{ fontSize: "0.82rem", color: "var(--text-2)" }}>
              {checkLabels[k] || k}
            </span>
          </div>
        ))}
      </div>

      {/* Verdict */}
      <div style={{
        padding: "1rem 1.25rem", borderRadius: "10px",
        background: passed ? "var(--green-dim)" : "var(--orange-dim)",
        border: `1.5px solid ${passed ? "var(--green)" : "var(--orange)"}`,
      }}>
        <div style={{ fontSize: "0.9rem", fontWeight: 700, color: passed ? "var(--green)" : "var(--orange)", marginBottom: a.reasons?.length ? "0.5rem" : 0 }}>
          {passed ? "✓ Passed — brief is publishing" : "⚠ Escalated for human review"}
        </div>
        {a.reasons?.map((r, i) => (
          <div key={i} style={{ fontSize: "0.82rem", color: "var(--text-3)", marginTop: "0.25rem" }}>{r}</div>
        ))}
      </div>
    </div>
  );
}

// ── Human review panel ─────────────────────────────────────────────────────────

function HumanPanel({ reviewer, notes, deciding, onReviewer, onNotes, onDecide }: {
  reviewer: string; notes: string; deciding: boolean;
  onReviewer: (v: string) => void; onNotes: (v: string) => void;
  onDecide: (d: "approve" | "reject") => void;
}) {
  const inp: React.CSSProperties = {
    width: "100%", background: "var(--surface)",
    border: "1.5px solid var(--border-2)", borderRadius: "8px",
    padding: "0.5rem 0.8rem", fontSize: "0.83rem",
    color: "var(--text)", outline: "none",
  };
  return (
    <div style={{
      marginTop: "1.25rem",
      border: "1.5px solid var(--orange)", borderRadius: "12px",
      background: "var(--orange-dim)", padding: "1.25rem",
    }}>
      <p style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.09em", color: "var(--orange)", margin: "0 0 0.5rem" }}>
        ⚠ HUMAN REVIEW REQUIRED
      </p>
      <p style={{ fontSize: "0.83rem", color: "var(--text-3)", margin: "0 0 0.875rem", lineHeight: 1.5 }}>
        The Reviewer escalated this brief. Read the draft in the Brief tab and make a call.
      </p>
      <input type="text" placeholder="Your name (optional)" value={reviewer}
        onChange={(e) => onReviewer(e.target.value)} style={{ ...inp, marginBottom: "0.5rem" }} />
      <textarea placeholder="Notes (optional)" value={notes} rows={2}
        onChange={(e) => onNotes(e.target.value)}
        style={{ ...inp, resize: "none", marginBottom: "0.75rem", fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button onClick={() => onDecide("approve")} disabled={deciding}
          style={{
            flex: 1, padding: "0.625rem", borderRadius: "8px",
            background: "var(--green)", color: "#fff", border: "none",
            fontSize: "0.85rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✓ Approve &amp; Publish
        </button>
        <button onClick={() => onDecide("reject")} disabled={deciding}
          style={{
            flex: 1, padding: "0.625rem", borderRadius: "8px",
            background: "var(--surface)", color: "var(--red)",
            border: "1.5px solid var(--red)",
            fontSize: "0.85rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✗ Reject
        </button>
      </div>
    </div>
  );
}

// ── Event log ──────────────────────────────────────────────────────────────────

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
              display: "flex", gap: "0.75rem",
              fontFamily: "var(--font-mono, monospace)", fontSize: "0.72rem",
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
