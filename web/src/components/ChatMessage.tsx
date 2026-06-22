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

export function ChatMessage({ job, onDecision }: { job: Job; onDecision: () => void }) {
  const [handoffs,       setHandoffs]       = useState<Handoff[]>([]);
  const [events,         setEvents]         = useState<Event[]>([]);
  const [reviews,        setReviews]        = useState<Review[]>([]);
  const [reasoningOpen,  setReasoningOpen]  = useState(true);
  const [reviewer,       setReviewer]       = useState("");
  const [notes,          setNotes]          = useState("");
  const [deciding,       setDeciding]       = useState(false);
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

        {/* ── 2. Sources (shown once collector finishes) ── */}
        {collectorH && (
          <div style={{ borderBottom: "1px solid #F1F5F9", padding: "1rem 1.125rem" }}>
            <p style={{
              margin: "0 0 0.75rem",
              fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.07em",
              color: "#94A3B8", textTransform: "uppercase" as const,
            }}>
              Sources ({(collectorH.artifact as unknown as CollectorArtifact).count ?? 0})
            </p>
            <SourcesList handoff={collectorH} />
          </div>
        )}

        {/* ── 3. Brief + PDF download ── */}
        {writerArt?.brief_markdown && (
          <div style={{ padding: "1.25rem 1.5rem" }}>
            <div ref={briefRef} className="brief-content">
              <ReactMarkdown>{writerArt.brief_markdown}</ReactMarkdown>
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

        {/* Queued state — no brief yet, show waiting */}
        {job.status === "queued" && !writerArt && (
          <div style={{ padding: "1rem 1.125rem 1.25rem" }}>
            <p style={{
              margin: 0, fontSize: "0.83rem", color: "#94A3B8",
              fontStyle: "italic",
            }}>
              Queued — waiting for an agent to pick this up…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agent steps (the chain-of-thought reasoning block) ────────────────────────

function AgentSteps({ job, collectorH, writerH, reviewerH }: {
  job: Job;
  collectorH: Handoff | null;
  writerH: Handoff | null;
  reviewerH: Handoff | null;
}) {
  const order = ["queued", "collecting", "writing", "review", "published", "escalated", "failed"];
  const statusIdx = order.indexOf(job.status);

  const cDone    = !!collectorH;
  const wDone    = !!writerH;
  const rDone    = !!reviewerH;
  const cActive  = !cDone && statusIdx >= order.indexOf("collecting");
  const wActive  = !wDone && statusIdx >= order.indexOf("writing");
  const rActive  = !rDone && (job.status === "review" || job.status === "published" || job.status === "escalated");

  return (
    <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.78rem" }}>

      {/* ── Collector ── */}
      <AgentSection
        icon="◈" label="Collector" color="#4361EE"
        done={cDone} active={cActive} pending={!cDone && !cActive}
        tokens={collectorH?.tokens_used}
        summary={cDone ? (() => {
          const a = collectorH!.artifact as unknown as CollectorArtifact;
          return `Found ${a.count ?? 0} sources`;
        })() : undefined}
      >
        {cDone && collectorH && <CollectorSteps handoff={collectorH} topic={job.topic} />}
        {cActive && <ThinkingSteps steps={[
          `Searching Google News RSS for "${job.topic}"`,
          "Querying Hacker News Algolia API",
          "Scoring candidates for relevance",
          "Selecting top sources",
        ]} />}
      </AgentSection>

      {/* Handoff pill: Collector → Writer */}
      {cDone && <HandoffLine handoff={collectorH!} />}

      {/* ── Writer ── */}
      {(wDone || wActive || statusIdx >= order.indexOf("writing")) && (
        <AgentSection
          icon="✦" label="Writer" color="#8B5CF6"
          done={wDone} active={wActive} pending={!wDone && !wActive}
          tokens={writerH?.tokens_used}
          summary={wDone ? (() => {
            const a = writerH!.artifact as unknown as WriterArtifact;
            return `${a.word_count ?? 0} words · ${a.citations?.length ?? 0} citations`;
          })() : undefined}
        >
          {wDone && writerH && <WriterSteps handoff={writerH} />}
          {wActive && <ThinkingSteps steps={[
            "Reading sources from Collector",
            "Drafting research brief in Markdown",
            "Adding citations",
          ]} />}
        </AgentSection>
      )}

      {/* Handoff pill: Writer → Reviewer */}
      {wDone && <HandoffLine handoff={writerH!} />}

      {/* ── Reviewer ── */}
      {(rDone || rActive || statusIdx >= order.indexOf("review")) && (
        <AgentSection
          icon="◉" label="Reviewer" color="#F59E0B"
          done={rDone} active={rActive} pending={!rDone && !rActive}
          tokens={reviewerH?.tokens_used}
          summary={rDone ? (() => {
            const a = reviewerH!.artifact as unknown as ReviewerArtifact;
            return `${((a.confidence ?? 0) * 100).toFixed(0)}% confidence · ${a.verdict}`;
          })() : undefined}
        >
          {rDone && reviewerH && <ReviewerSteps handoff={reviewerH} />}
          {rActive && <ThinkingSteps steps={[
            "Checking citation support",
            "Evaluating topic coverage",
            "Verifying factuality",
            "Computing confidence score",
          ]} />}
        </AgentSection>
      )}
    </div>
  );
}

// ── Agent section shell ────────────────────────────────────────────────────────

function AgentSection({ icon, label, color, done, active, pending, tokens, summary, children }: {
  icon: string; label: string; color: string;
  done: boolean; active: boolean; pending: boolean;
  tokens?: number | null; summary?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(active || done);

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  const statusColor = done ? "#059669" : active ? color : "#CBD5E1";
  const statusText  = done ? "done" : active ? "running" : "waiting";

  return (
    <div style={{ borderBottom: "1px solid #E4E8F0" }}>
      {/* Section header — always visible */}
      <button
        onClick={() => !pending && setOpen((o) => !o)}
        style={{
          width: "100%", background: "none", border: "none",
          display: "flex", alignItems: "center", gap: "0.5rem",
          padding: "0.625rem 0.875rem",
          cursor: pending ? "default" : "pointer",
          textAlign: "left",
        }}
      >
        {/* Expand/collapse arrow */}
        <span style={{
          display: "inline-block", fontSize: "0.6rem", color: "#CBD5E1", flexShrink: 0,
          transform: open ? "rotate(90deg)" : "rotate(0)",
          transition: "transform 0.15s", opacity: pending ? 0.4 : 1,
        }}>▶</span>

        {/* Agent icon + name */}
        <span style={{ color, fontSize: "0.85rem", flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontWeight: 700, color: pending ? "#CBD5E1" : "#1E293B",
          fontSize: "0.78rem", letterSpacing: "0.02em",
        }}>{label}</span>

        {/* Summary (when collapsed + done) */}
        {summary && !open && (
          <span style={{ fontSize: "0.72rem", color: "#94A3B8", marginLeft: "0.25rem" }}>
            — {summary}
          </span>
        )}

        {/* Right: tokens + status */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.625rem" }}>
          {tokens != null && tokens > 0 && (
            <span style={{ fontSize: "0.67rem", color: "#94A3B8" }}>{tokens.toLocaleString()} tok</span>
          )}
          <span style={{
            display: "flex", alignItems: "center", gap: "0.25rem",
            fontSize: "0.67rem", fontWeight: 600, color: statusColor,
          }}>
            {active && (
              <span className="dot-pulse" style={{ display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: color }} />
            )}
            {statusText}
          </span>
        </div>
      </button>

      {/* Expanded content */}
      {open && children && (
        <div style={{ padding: "0 0.875rem 0.75rem 2.25rem" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Handoff line between agents ────────────────────────────────────────────────

function HandoffLine({ handoff }: { handoff: Handoff }) {
  let detail = "";
  if (handoff.from_stage === "collecting") {
    const a = handoff.artifact as unknown as CollectorArtifact;
    detail = `${a.count ?? 0} sources`;
  } else if (handoff.from_stage === "writing") {
    const a = handoff.artifact as unknown as WriterArtifact;
    detail = `${a.word_count ?? 0} words`;
  } else if (handoff.from_stage === "review") {
    const a = handoff.artifact as unknown as ReviewerArtifact;
    detail = `${((a.confidence ?? 0) * 100).toFixed(0)}% confidence`;
  }

  return (
    <div className="handoff-record" style={{
      display: "flex", alignItems: "center", gap: "0.5rem",
      padding: "0.35rem 0.875rem 0.35rem 2.25rem",
      background: "#F0F4FF",
      borderBottom: "1px solid #E4E8F0",
      fontSize: "0.7rem",
    }}>
      <span style={{ color: "#94A3B8" }}>↓</span>
      <span style={{
        fontWeight: 700, color: "#4361EE",
        fontFamily: "var(--font-mono, monospace)",
      }}>handoff</span>
      <span style={{ color: "#94A3B8" }}>
        {handoff.from_stage} → {handoff.to_stage}
      </span>
      {detail && (
        <>
          <span style={{ color: "#D1D5DB" }}>·</span>
          <span style={{ fontWeight: 600, color: "#374151" }}>{detail}</span>
        </>
      )}
      <span style={{ color: "#CBD5E1", marginLeft: "auto" }}>
        {new Date(handoff.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

// ── Thinking steps (active agent) ─────────────────────────────────────────────

function ThinkingSteps({ steps }: { steps: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {steps.map((s, i) => (
        <div key={i} className="thought" style={{
          display: "flex", alignItems: "baseline", gap: "0.5rem",
          color: "#94A3B8", animationDelay: `${i * 0.07}s`,
        }}>
          <span style={{ color: "#4361EE", flexShrink: 0, fontSize: "0.65rem" }}>▸</span>
          <span>{s}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginTop: "0.1rem" }}>
        <span style={{ color: "#4361EE", fontSize: "0.65rem" }}>▸</span>
        <span className="cursor" />
      </div>
    </div>
  );
}

// ── Collector steps (completed) ────────────────────────────────────────────────

function CollectorSteps({ handoff, topic }: { handoff: Handoff; topic: string }) {
  const a = handoff.artifact as unknown as CollectorArtifact;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <ThoughtLine text={`Searched Google News RSS for "${topic}"`} tone="done" />
      <ThoughtLine text="Queried Hacker News Algolia API" tone="done" />
      {a.notes && <ThoughtLine text={a.notes} tone="info" />}
      <ThoughtLine text={`Selected ${a.count ?? 0} source${a.count !== 1 ? "s" : ""}`} tone="done" />

      {/* Sources list */}
      {a.sources?.length > 0 && (
        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {a.sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "baseline", gap: "0.5rem",
                textDecoration: "none", color: "inherit",
                padding: "0.25rem 0.375rem", borderRadius: "5px",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#EEF2FF"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
            >
              <span style={{ color: "#94A3B8", flexShrink: 0 }}>[{i + 1}]</span>
              <span style={{ color: "#4361EE", fontFamily: "inherit", fontSize: "0.78rem", lineHeight: 1.4 }}>
                {s.title || s.url}
              </span>
              {s.source && <span style={{ color: "#CBD5E1", flexShrink: 0 }}>— {s.source}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Writer steps (completed) ───────────────────────────────────────────────────

function WriterSteps({ handoff }: { handoff: Handoff }) {
  const a = handoff.artifact as unknown as WriterArtifact;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <ThoughtLine text="Read sources from Collector" tone="done" />
      <ThoughtLine text={`Drafted "${a.title || "Research Brief"}"`} tone="done" />
      <ThoughtLine text={`${a.word_count ?? "—"} words · ${a.citations?.length ?? 0} citation${a.citations?.length !== 1 ? "s" : ""}`} tone="info" />
    </div>
  );
}

// ── Reviewer steps (completed) ─────────────────────────────────────────────────

function ReviewerSteps({ handoff }: { handoff: Handoff }) {
  const a = handoff.artifact as unknown as ReviewerArtifact;
  const conf = (a.confidence ?? 0) * 100;
  const passed = a.verdict !== "escalate" && conf >= 70;

  const checkLabels: Record<string, string> = {
    citations_supported: "Citations supported",
    coverage:            "Topic coverage",
    factuality:          "Factuality",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {a.checks && Object.entries(a.checks).map(([k, v]) => (
        <ThoughtLine key={k} text={`${checkLabels[k] || k}: ${v ? "PASS" : "FAIL"}`} tone={v ? "done" : "fail"} />
      ))}
      <ThoughtLine text={`Confidence: ${conf.toFixed(0)}%`} tone="info" />
      <ThoughtLine text={`Verdict: ${(a.verdict ?? "unknown").toUpperCase()}`} tone={passed ? "done" : "fail"} />
      {a.reasons?.map((r, i) => (
        <ThoughtLine key={i} text={r} tone="info" />
      ))}
    </div>
  );
}

// ── Thought line ───────────────────────────────────────────────────────────────

function ThoughtLine({ text, tone }: { text: string; tone: "done" | "fail" | "info" }) {
  const color = { done: "#059669", fail: "#DC2626", info: "#64748B" }[tone];
  const arrow = { done: "✓", fail: "✗", info: "▸" }[tone];
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
      <span style={{ color, flexShrink: 0, fontSize: "0.68rem", fontWeight: tone === "info" ? 400 : 700 }}>
        {arrow}
      </span>
      <span style={{ color }}>{text}</span>
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
  onDecide: (d: "approve" | "reject") => void;
}) {
  const inp: React.CSSProperties = {
    width: "100%", background: "#F8F9FC",
    border: "1.5px solid #E4E8F0", borderRadius: "8px",
    padding: "0.5rem 0.75rem", fontSize: "0.83rem",
    color: "#0D0F12", outline: "none", fontFamily: "inherit",
  };
  return (
    <div style={{
      marginTop: "1.25rem",
      border: "1.5px solid #EA580C", borderRadius: "12px",
      background: "#FFF7ED", padding: "1.125rem",
    }}>
      <p style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.08em", color: "#EA580C", margin: "0 0 0.375rem" }}>
        ⚠ HUMAN REVIEW REQUIRED
      </p>
      <p style={{ fontSize: "0.83rem", color: "#92400E", margin: "0 0 0.875rem", lineHeight: 1.55 }}>
        The Reviewer escalated this brief. Read the draft above and decide.
      </p>
      <input type="text" placeholder="Your name (optional)" value={reviewer}
        onChange={(e) => onReviewer(e.target.value)}
        style={{ ...inp, marginBottom: "0.5rem" }} />
      <textarea placeholder="Notes (optional)" value={notes} rows={2}
        onChange={(e) => onNotes(e.target.value)}
        style={{ ...inp, resize: "none", marginBottom: "0.75rem" }} />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button onClick={() => onDecide("approve")} disabled={deciding}
          style={{
            flex: 1, padding: "0.6rem", borderRadius: "8px",
            background: "#059669", color: "#fff", border: "none",
            fontSize: "0.85rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✓ Approve &amp; Publish
        </button>
        <button onClick={() => onDecide("reject")} disabled={deciding}
          style={{
            flex: 1, padding: "0.6rem", borderRadius: "8px",
            background: "#fff", color: "#DC2626",
            border: "1.5px solid #DC2626",
            fontSize: "0.85rem", fontWeight: 700,
            cursor: deciding ? "default" : "pointer", opacity: deciding ? 0.5 : 1,
          }}>
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
