"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase, type Job, type Handoff, type Event, type Review } from "@/lib/supabase";

// ── Artifact shapes ────────────────────────────────────────────────────────────

interface Source {
  title: string; url: string; snippet: string; published: string; source: string;
}
interface CollectorArtifact {
  sources: Source[]; count: number; notes: string;
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

// ── Brief cleanup (strip Sources section + inline [n] citation markers) ───────

function cleanBrief(md: string): string {
  return md
    .replace(/^##\s+(Sources|References|Bibliography|Citations|Further Reading)[^\n]*[\s\S]*/im, "")
    .replace(/\s*\[\d+(?:[,\s]+\d+)*\]/g, "")
    .trim();
}

// ── PDF download ───────────────────────────────────────────────────────────────

function downloadPDF(topic: string, el: HTMLElement | null) {
  if (!el) return;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${topic}</title>
<style>body{font-family:Georgia,serif;max-width:680px;margin:52px auto;line-height:1.78;color:#111827;font-size:15px}
h1{font-size:22px;font-weight:700;margin:0 0 10px}h2{font-size:17px;font-weight:600;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin:28px 0 10px}
p{margin:0 0 16px;color:#374151}ul,ol{padding-left:22px;margin:8px 0 16px}li{margin:6px 0;color:#374151}
a{color:#4361EE}strong{font-weight:700}code{font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px}
.foot{margin-top:48px;font-size:11px;color:#9CA3AF;border-top:1px solid #e2e8f0;padding-top:12px}</style>
</head><body><h1>${topic}</h1>${el.innerHTML}
<div class="foot">Research Desk · ${new Date().toLocaleDateString()} · Collector → Writer → Reviewer</div>
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}

// ── Status pill ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const cfg: Record<string, { label: string; bg: string; color: string }> = {
    queued:     { label: "Queued",      bg: "#F1F5F9", color: "#475569" },
    collecting: { label: "Collecting", bg: "#EEF2FF", color: "#4361EE" },
    writing:    { label: "Writing",    bg: "#F5F3FF", color: "#7C3AED" },
    review:     { label: "Reviewing",  bg: "#FFFBEB", color: "#92400E" },
    published:  { label: "Published",  bg: "#ECFDF5", color: "#065F46" },
    escalated:  { label: "Needs review", bg: "#FFF7ED", color: "#9A3412" },
    failed:     { label: "Failed",     bg: "#FEF2F2", color: "#991B1B" },
  };
  const c = cfg[status] ?? cfg.queued;
  return (
    <span style={{
      fontSize: "0.67rem", fontWeight: 700, letterSpacing: "0.04em",
      padding: "0.15rem 0.55rem", borderRadius: "999px",
      background: c.bg, color: c.color,
    }}>
      {c.label}
    </span>
  );
}

// ── Root ChatMessage ───────────────────────────────────────────────────────────

export function ChatMessage({ job, onDecision, onRetry }: {
  job: Job;
  onDecision: () => void;
  onRetry: (jobId: string) => void;
}) {
  const [handoffs,       setHandoffs]       = useState<Handoff[]>([]);
  const [events,         setEvents]         = useState<Event[]>([]);
  const [reviews,        setReviews]        = useState<Review[]>([]);
  const [reasoningOpen,  setReasoningOpen]  = useState(true);
  const [sourcesOpen,    setSourcesOpen]    = useState(false);
  const [reviewer,       setReviewer]       = useState("");
  const [notes,          setNotes]          = useState("");
  const [deciding,       setDeciding]       = useState(false);
  const [retrying,       setRetrying]       = useState(false);
  const briefRef = useRef<HTMLDivElement>(null);

  // Auto-collapse reasoning when job finishes
  useEffect(() => {
    const isActive = ["queued", "collecting", "writing", "review"].includes(job.status);
    if (!isActive) setReasoningOpen(false);
  }, [job.status]);

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
      .channel(`msg-${job.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "handoffs", filter: `job_id=eq.${job.id}` },
        (p) => setHandoffs((prev) => [...prev, p.new as Handoff])
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `job_id=eq.${job.id}` },
        (p) => setEvents((prev) => [...prev, p.new as Event])
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [job.id]);

  const decide = async (d: "approve" | "reject" | "revise") => {
    setDeciding(true);
    await supabase.from("reviews").insert({
      job_id: job.id, decision: d,
      notes: notes || null, reviewer: reviewer || "anonymous",
    });
    if (d === "approve") {
      await supabase.from("jobs").update({ status: "published" }).eq("id", job.id);
      onDecision();
    } else if (d === "reject") {
      await supabase.from("jobs").update({ status: "failed" }).eq("id", job.id);
      onDecision();
    } else {
      // revise: reset to writing — orchestrator's writer stage picks it up
      // writer will read the revise review and inject instructions into its prompt
      await supabase.from("jobs").update({
        status: "writing", attempts: 0, locked_at: null,
      }).eq("id", job.id);
      onRetry(job.id); // switch to live mode to watch the re-run
    }
    setDeciding(false);
  };

  const handleRetry = async () => {
    setRetrying(true);
    await supabase.from("jobs").update({
      status: "queued",
      attempts: 0,
      locked_at: null,
      locked_by: null,
    }).eq("id", job.id);
    setRetrying(false);
    onRetry(job.id);
  };

  const collectorH = handoffs.find((h) => h.from_stage === "collecting");
  const writerH    = handoffs.find((h) => h.from_stage === "writing");
  const reviewerH  = handoffs.find((h) => h.from_stage === "review");
  const writerArt  = writerH ? (writerH.artifact as unknown as WriterArtifact) : null;

  const totalTokens = handoffs.reduce((s, h) => s + (h.tokens_used ?? 0), 0);
  const isActive = ["queued", "collecting", "writing", "review"].includes(job.status);

  const reasoningLabel = isActive
    ? "Thinking…"
    : `Pipeline · ${handoffs.length} agent${handoffs.length !== 1 ? "s" : ""}${totalTokens > 0 ? ` · ${totalTokens.toLocaleString()} tokens` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>

      {/* User bubble */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{
          maxWidth: "78%",
          background: "#EEF2FF",
          border: "1px solid #C7D2FE",
          borderRadius: "14px 14px 4px 14px",
          padding: "0.75rem 1.125rem",
          fontSize: "0.9rem", fontWeight: 600, color: "#1E3A8A",
          lineHeight: 1.45,
        }}>
          {job.topic}
        </div>
      </div>

      {/* Agent response bubble */}
      <div style={{
        background: "#fff",
        border: "1px solid #E4E8F0",
        borderRadius: "4px 14px 14px 14px",
        overflow: "hidden",
        boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
      }}>
        {/* Bubble header */}
        <div style={{
          display: "flex", alignItems: "center", gap: "0.625rem",
          padding: "0.7rem 1.125rem",
          borderBottom: "1px solid #F1F5F9",
        }}>
          <div style={{
            width: "22px", height: "22px", borderRadius: "6px",
            background: "linear-gradient(135deg, #4361EE 0%, #8B5CF6 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: "10px", flexShrink: 0,
          }}>R</div>
          <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#374151" }}>Research Desk</span>
          <StatusPill status={job.status} />
          <span style={{ fontSize: "0.72rem", color: "#CBD5E1", marginLeft: "auto" }}>
            {new Date(job.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {/* ── 1. COT Reasoning (collapsible) ── */}
        <div style={{ borderBottom: "1px solid #F1F5F9" }}>
          <button
            onClick={() => setReasoningOpen((o) => !o)}
            style={{
              width: "100%", background: "none", border: "none",
              display: "flex", alignItems: "center", gap: "0.45rem",
              padding: "0.7rem 1.125rem", cursor: "pointer", textAlign: "left",
            }}
          >
            <span style={{
              display: "inline-block",
              transform: reasoningOpen ? "rotate(90deg)" : "rotate(0)",
              transition: "transform 0.18s ease",
              fontSize: "0.6rem", color: "#94A3B8", flexShrink: 0,
            }}>▶</span>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: isActive ? "#4361EE" : "#64748B" }}>
              {reasoningLabel}
            </span>
            {isActive && (
              <span className="dot-pulse" style={{
                display: "inline-block", width: "5px", height: "5px",
                borderRadius: "50%", background: "#4361EE", flexShrink: 0,
              }} />
            )}
          </button>

          {reasoningOpen && (
            <div style={{ margin: "0 1.125rem 0.875rem" }}>
              <div style={{
                background: "#F8F9FC", border: "1px solid #E4E8F0",
                borderRadius: "10px", overflow: "hidden",
              }}>
                <AgentSteps
                  job={job}
                  collectorH={collectorH ?? null}
                  writerH={writerH ?? null}
                  reviewerH={reviewerH ?? null}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── 2. Sources (collapsible, shown once collector finishes) ── */}
        {collectorH && (
          <div style={{ borderBottom: "1px solid #F1F5F9" }}>
            <button
              onClick={() => setSourcesOpen((o) => !o)}
              style={{
                width: "100%", background: "none", border: "none",
                display: "flex", alignItems: "center", gap: "0.45rem",
                padding: "0.7rem 1.125rem", cursor: "pointer", textAlign: "left",
              }}
            >
              <span style={{
                display: "inline-block",
                transform: sourcesOpen ? "rotate(90deg)" : "rotate(0)",
                transition: "transform 0.18s ease",
                fontSize: "0.6rem", color: "#94A3B8", flexShrink: 0,
              }}>▶</span>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#64748B" }}>
                Sources ({(collectorH.artifact as unknown as CollectorArtifact).count ?? 0})
              </span>
            </button>
            {sourcesOpen && (
              <div style={{ padding: "0 1.125rem 0.875rem" }}>
                <SourcesList handoff={collectorH} />
              </div>
            )}
          </div>
        )}

        {/* ── 3. Brief + PDF download ── */}
        {writerArt?.brief_markdown && (
          <div style={{ padding: "1.25rem 1.5rem" }}>
            <div ref={briefRef} className="brief-content">
              <ReactMarkdown>{cleanBrief(writerArt.brief_markdown)}</ReactMarkdown>
            </div>

            <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              {(job.status === "published" || job.status === "escalated") && (
                <button
                  onClick={() => downloadPDF(job.topic, briefRef.current)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "0.375rem",
                    padding: "0.45rem 1rem", borderRadius: "8px",
                    background: "#ECFDF5", border: "1.5px solid #059669",
                    color: "#059669", fontSize: "0.8rem", fontWeight: 700,
                    cursor: "pointer", letterSpacing: "-0.01em",
                  }}
                >
                  ↓ Save as PDF
                </button>
              )}
            </div>

            {/* Reviewer reviews */}
            {reviews.map((r) => (
              <div key={r.id} style={{
                marginTop: "0.875rem", display: "flex", alignItems: "center", gap: "0.5rem",
                padding: "0.5rem 0.875rem", borderRadius: "8px", fontSize: "0.8rem",
                background: r.decision === "approve" ? "#ECFDF5" : "#FEF2F2",
                border: `1px solid ${r.decision === "approve" ? "#059669" : "#DC2626"}`,
              }}>
                <span style={{ fontWeight: 700, color: r.decision === "approve" ? "#059669" : "#DC2626" }}>
                  {r.decision === "approve" ? "✓ Approved & Published" : "✗ Rejected"}
                </span>
                {r.reviewer && <span style={{ color: "#6B7280" }}>by {r.reviewer}</span>}
                {r.notes && <span style={{ color: "#374151" }}>— {r.notes}</span>}
              </div>
            ))}

            {/* Human review panel */}
            {job.status === "escalated" && reviews.length === 0 && (
              <HumanPanel reviewer={reviewer} notes={notes} deciding={deciding}
                onReviewer={setReviewer} onNotes={setNotes} onDecide={decide} />
            )}
          </div>
        )}

        {/* Queued state — no brief yet */}
        {job.status === "queued" && !writerArt && (
          <div style={{ padding: "1rem 1.125rem 1.25rem" }}>
            <p style={{ margin: 0, fontSize: "0.83rem", color: "#94A3B8", fontStyle: "italic" }}>
              Queued — waiting for an agent to pick this up…
            </p>
          </div>
        )}

        {/* Failed state — retry panel */}
        {job.status === "failed" && (
          <div style={{ padding: "1rem 1.125rem 1.25rem" }}>
            <div style={{
              border: "1.5px solid #FECACA", borderRadius: "12px",
              background: "#FEF2F2", padding: "1rem 1.125rem",
            }}>
              <p style={{ margin: "0 0 0.25rem", fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.07em", color: "#DC2626" }}>
                PIPELINE FAILED
              </p>
              <p style={{ margin: "0 0 0.875rem", fontSize: "0.83rem", color: "#7F1D1D", lineHeight: 1.55 }}>
                The job failed to complete. Click below to requeue it — the agents will run it from scratch.
              </p>
              <button
                onClick={handleRetry}
                disabled={retrying}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "0.375rem",
                  padding: "0.5rem 1.125rem", borderRadius: "8px",
                  background: retrying ? "#F3F4F6" : "#1E293B",
                  border: "none", color: retrying ? "#9CA3AF" : "#fff",
                  fontSize: "0.83rem", fontWeight: 700, cursor: retrying ? "default" : "pointer",
                  transition: "background 0.15s",
                }}
              >
                {retrying ? "Requeueing…" : "↺ Retry this job"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agent steps — flat flowing stream (Claude / ChatGPT style) ───────────────

function AgentSteps({ job, collectorH, writerH, reviewerH }: {
  job: Job;
  collectorH: Handoff | null;
  writerH: Handoff | null;
  reviewerH: Handoff | null;
}) {
  const order = ["queued", "collecting", "writing", "review", "published", "escalated", "failed"];
  const statusIdx = order.indexOf(job.status);

  const cDone   = !!collectorH;
  const wDone   = !!writerH;
  const rDone   = !!reviewerH;
  const cActive = !cDone && statusIdx >= order.indexOf("collecting");
  const wActive = !wDone && statusIdx >= order.indexOf("writing");
  const rActive = !rDone && ["review", "published", "escalated"].includes(job.status);

  const mono: React.CSSProperties = { fontFamily: "var(--font-mono, monospace)", fontSize: "0.79rem", lineHeight: 1.7 };

  return (
    <div style={{
      ...mono,
      background: "#F8F9FC",
      borderLeft: "3px solid #C7D2FE",
      borderRadius: "0 8px 8px 0",
      padding: "1rem 1.125rem",
      display: "flex", flexDirection: "column", gap: 0,
    }}>

      {/* ── Collector ── */}
      <AgentLabel label="Collector" color="#4361EE" active={cActive} done={cDone}
        tokens={collectorH?.tokens_used} />

      {cActive && (
        <StreamLines color="#4361EE" lines={[
          `Searching Google News RSS for "${job.topic}"`,
          "Querying Hacker News Algolia API",
          "Scoring candidates for relevance",
          "Selecting top sources",
        ]} showCursor />
      )}

      {cDone && collectorH && (() => {
        const a = collectorH.artifact as unknown as CollectorArtifact;
        return (
          <StreamLines color="#4361EE" lines={[
            `Searched Google News & Hacker News`,
            a.notes ? a.notes : null,
            `Selected ${a.count ?? 0} source${a.count !== 1 ? "s" : ""}`,
          ].filter(Boolean) as string[]} />
        );
      })()}

      {/* Handoff divider: Collector → Writer */}
      {cDone && collectorH && <HandoffDivider handoff={collectorH} />}

      {/* ── Writer ── */}
      {(wDone || wActive || statusIdx >= order.indexOf("writing")) && <>
        <AgentLabel label="Writer" color="#8B5CF6" active={wActive} done={wDone}
          tokens={writerH?.tokens_used} />

        {wActive && (
          <StreamLines color="#8B5CF6" lines={[
            "Reading source list from Collector",
            "Drafting research brief in Markdown",
            "Weaving in citations",
          ]} showCursor />
        )}

        {wDone && writerH && (() => {
          const a = writerH.artifact as unknown as WriterArtifact;
          return (
            <StreamLines color="#8B5CF6" lines={[
              `Drafted "${a.title || "Research Brief"}"`,
              `${a.word_count ?? "—"} words · ${a.citations?.length ?? 0} citations`,
            ]} />
          );
        })()}
      </>}

      {/* Handoff divider: Writer → Reviewer */}
      {wDone && writerH && <HandoffDivider handoff={writerH} />}

      {/* ── Reviewer ── */}
      {(rDone || rActive || statusIdx >= order.indexOf("review")) && <>
        <AgentLabel label="Reviewer" color="#D97706" active={rActive} done={rDone}
          tokens={reviewerH?.tokens_used} />

        {rActive && (
          <StreamLines color="#D97706" lines={[
            "Checking citation support",
            "Evaluating topic coverage",
            "Verifying factuality",
            "Computing confidence score",
          ]} showCursor />
        )}

        {rDone && reviewerH && (() => {
          const a = reviewerH.artifact as unknown as ReviewerArtifact;
          const conf = (a.confidence ?? 0) * 100;
          const passed = a.verdict !== "escalate" && conf >= 70;
          const checkLabels: Record<string, string> = {
            citations_supported: "Citations supported",
            coverage:            "Topic coverage",
            factuality:          "Factuality",
          };
          const checkLines = a.checks
            ? Object.entries(a.checks).map(([k, v]) => ({ text: `${checkLabels[k] || k}: ${v ? "pass" : "fail"}`, ok: v as boolean }))
            : [];
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {checkLines.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: "0.5rem", color: c.ok ? "#059669" : "#DC2626" }}>
                  <span style={{ flexShrink: 0, fontSize: "0.7rem" }}>{c.ok ? "✓" : "✗"}</span>
                  <span>{c.text}</span>
                </div>
              ))}
              <div style={{ display: "flex", gap: "0.5rem", color: "#64748B", marginTop: "0.2rem" }}>
                <span style={{ flexShrink: 0, fontSize: "0.7rem" }}>◈</span>
                <span>Confidence {conf.toFixed(0)}% · verdict: <strong style={{ color: passed ? "#059669" : "#DC2626" }}>{a.verdict}</strong></span>
              </div>
              {a.reasons?.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: "0.5rem", color: "#94A3B8", paddingLeft: "1.1rem" }}>
                  <span>— {r}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </>}
    </div>
  );
}

// ── Agent label row ───────────────────────────────────────────────────────────

function AgentLabel({ label, color, active, done, tokens }: {
  label: string; color: string; active: boolean; done: boolean; tokens?: number | null;
}) {
  const statusColor = done ? "#059669" : active ? color : "#CBD5E1";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.5rem",
      marginBottom: "0.375rem",
      paddingBottom: "0.2rem",
    }}>
      <span style={{
        fontSize: "0.65rem", fontWeight: 800, letterSpacing: "0.1em",
        color: done ? "#059669" : active ? color : "#CBD5E1",
        textTransform: "uppercase" as const,
      }}>{label}</span>
      {active && (
        <span className="dot-pulse" style={{ display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: color }} />
      )}
      {done && <span style={{ fontSize: "0.65rem", color: "#059669" }}>✓</span>}
      {tokens != null && tokens > 0 && (
        <span style={{ fontSize: "0.65rem", color: "#CBD5E1", marginLeft: "auto" }}>
          {tokens.toLocaleString()} tok
        </span>
      )}
      {!done && !active && (
        <span style={{ fontSize: "0.65rem", color: "#CBD5E1" }}>waiting</span>
      )}
    </div>
  );
}

// ── Stream lines ──────────────────────────────────────────────────────────────

function StreamLines({ lines, color, showCursor }: { lines: string[]; color?: string; showCursor?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, marginBottom: "0.625rem" }}>
      {lines.map((line, i) => (
        <div key={i} className="thought" style={{
          display: "flex", alignItems: "baseline", gap: "0.5rem",
          color: "#64748B", animationDelay: `${i * 0.06}s`,
          paddingLeft: "0.75rem",
        }}>
          <span style={{ color: color ?? "#94A3B8", flexShrink: 0, fontSize: "0.6rem" }}>▸</span>
          <span>{line}</span>
        </div>
      ))}
      {showCursor && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", paddingLeft: "0.75rem" }}>
          <span style={{ color: color ?? "#94A3B8", fontSize: "0.6rem" }}>▸</span>
          <span className="cursor" />
        </div>
      )}
    </div>
  );
}

// ── Handoff divider ───────────────────────────────────────────────────────────

function HandoffDivider({ handoff }: { handoff: Handoff }) {
  let detail = "";
  if (handoff.from_stage === "collecting") {
    const a = handoff.artifact as unknown as CollectorArtifact;
    detail = `${a.count ?? 0} sources`;
  } else if (handoff.from_stage === "writing") {
    const a = handoff.artifact as unknown as WriterArtifact;
    detail = `${a.word_count ?? 0} words`;
  }

  return (
    <div className="handoff-record" style={{
      display: "flex", alignItems: "center", gap: "0.5rem",
      margin: "0.5rem 0",
      fontSize: "0.7rem",
    }}>
      <div style={{ flex: 1, height: "1px", background: "#E0E7FF" }} />
      <span style={{
        display: "inline-flex", alignItems: "center", gap: "0.375rem",
        padding: "0.2rem 0.625rem", borderRadius: "999px",
        background: "#EEF2FF", border: "1px solid #C7D2FE",
        color: "#4361EE", fontWeight: 700, fontFamily: "var(--font-mono, monospace)",
        whiteSpace: "nowrap" as const,
      }}>
        handoff
        <span style={{ color: "#94A3B8", fontWeight: 400 }}>
          {handoff.from_stage} → {handoff.to_stage}
        </span>
        {detail && <span style={{ color: "#6366F1" }}>· {detail}</span>}
      </span>
      <div style={{ flex: 1, height: "1px", background: "#E0E7FF" }} />
    </div>
  );
}

// ── Sources list (Sources tab) ────────────────────────────────────────────────

function SourcesList({ handoff }: { handoff: Handoff }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  if (!a.sources?.length) return (
    <p style={{ fontSize: "0.82rem", color: "#94A3B8", margin: 0, padding: "0.5rem 0" }}>No sources found.</p>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {a.sources.map((s, i) => (
        <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
          style={{
            display: "block", padding: "0.875rem 1rem", borderRadius: "10px",
            background: "#fff", border: "1.5px solid #E4E8F0",
            textDecoration: "none",
            transition: "border-color 0.15s, box-shadow 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "#4361EE";
            e.currentTarget.style.boxShadow = "0 2px 8px rgba(67,97,238,0.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "#E4E8F0";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: s.snippet ? "0.35rem" : 0 }}>
            <span style={{
              fontSize: "0.68rem", fontWeight: 700, color: "#94A3B8",
              fontFamily: "var(--font-mono, monospace)", flexShrink: 0,
            }}>[{i + 1}]</span>
            <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#4361EE", lineHeight: 1.3 }}>
              {s.title || s.url}
            </span>
          </div>
          {s.snippet && (
            <p style={{ margin: "0 0 0.3rem 1.375rem", fontSize: "0.8rem", color: "#64748B", lineHeight: 1.55 }}>
              {s.snippet.slice(0, 240)}{s.snippet.length > 240 ? "…" : ""}
            </p>
          )}
          <p style={{ margin: "0 0 0 1.375rem", fontSize: "0.72rem", color: "#CBD5E1" }}>
            {s.source}{s.published ? ` · ${new Date(s.published).toLocaleDateString()}` : ""}
          </p>
        </a>
      ))}
    </div>
  );
}

// ── Human review panel ─────────────────────────────────────────────────────────

function HumanPanel({ reviewer, notes, deciding, onReviewer, onNotes, onDecide }: {
  reviewer: string; notes: string; deciding: boolean;
  onReviewer: (v: string) => void; onNotes: (v: string) => void;
  onDecide: (d: "approve" | "reject" | "revise") => void;
}) {
  const inp: React.CSSProperties = {
    width: "100%", background: "#fff",
    border: "1.5px solid #FED7AA", borderRadius: "8px",
    padding: "0.5rem 0.75rem", fontSize: "0.83rem",
    color: "#0D0F12", outline: "none", fontFamily: "inherit",
  };
  const canRevise = notes.trim().length > 0;

  return (
    <div style={{
      marginTop: "1.25rem",
      border: "1.5px solid #EA580C", borderRadius: "12px",
      background: "#FFF7ED", padding: "1.25rem",
    }}>
      <p style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.08em", color: "#EA580C", margin: "0 0 0.25rem" }}>
        ⚠ HUMAN REVIEW REQUIRED
      </p>
      <p style={{ fontSize: "0.83rem", color: "#92400E", margin: "0 0 1rem", lineHeight: 1.6 }}>
        The AI Reviewer flagged this brief as low-confidence. Read the draft above, then approve, reject, or send it back to the Writer with specific instructions.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}>
        <input type="text" placeholder="Your name (optional)" value={reviewer}
          onChange={(e) => onReviewer(e.target.value)}
          style={inp} />
        <textarea
          placeholder="Revision instructions — e.g. &quot;Add more detail on cost, focus on enterprise use cases&quot; (required for Revise)"
          value={notes} rows={3}
          onChange={(e) => onNotes(e.target.value)}
          style={{ ...inp, resize: "none", lineHeight: 1.55 }} />
      </div>

      {/* Three action buttons */}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <button onClick={() => onDecide("approve")} disabled={deciding}
            style={{
              width: "100%", padding: "0.6rem", borderRadius: "8px",
              background: "#059669", color: "#fff", border: "none",
              fontSize: "0.82rem", fontWeight: 700,
              cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.6 : 1,
              transition: "opacity 0.15s",
            }}>
            ✓ Approve &amp; Publish
          </button>
          <p style={{ margin: 0, fontSize: "0.67rem", color: "#059669", textAlign: "center" }}>
            → Published
          </p>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <button onClick={() => onDecide("revise")} disabled={deciding || !canRevise}
            title={!canRevise ? "Add revision instructions above to enable" : undefined}
            style={{
              width: "100%", padding: "0.6rem", borderRadius: "8px",
              background: canRevise && !deciding ? "#4361EE" : "#E0E7FF",
              color: canRevise && !deciding ? "#fff" : "#A5B4FC",
              border: "none", fontSize: "0.82rem", fontWeight: 700,
              cursor: canRevise && !deciding ? "pointer" : "default",
              transition: "background 0.15s, color 0.15s",
            }}>
            ↺ Revise with AI
          </button>
          <p style={{ margin: 0, fontSize: "0.67rem", color: "#4361EE", textAlign: "center" }}>
            → Writer re-runs with your instructions
          </p>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <button onClick={() => onDecide("reject")} disabled={deciding}
            style={{
              width: "100%", padding: "0.6rem", borderRadius: "8px",
              background: "#fff", color: "#DC2626",
              border: "1.5px solid #DC2626",
              fontSize: "0.82rem", fontWeight: 700,
              cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
              transition: "opacity 0.15s",
            }}>
            ✗ Reject
          </button>
          <p style={{ margin: 0, fontSize: "0.67rem", color: "#DC2626", textAlign: "center" }}>
            → Failed
          </p>
        </div>
      </div>
    </div>
  );
}
