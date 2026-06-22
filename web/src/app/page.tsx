"use client";

import { useEffect, useState, useCallback } from "react";
import {
  supabase,
  STAGE_LABELS,
  STAGE_ORDER,
  type Job,
  type JobStatus,
} from "@/lib/supabase";
import { PipelineView } from "@/components/PipelineView";

// ── Per-stage visual config ───────────────────────────────────────────────────

const STAGE_CONF: Record<string, {
  dot: string; colBg: string; headerBg: string; headerText: string; border: string;
}> = {
  queued:     { dot:"#94A3B8", colBg:"#FAFBFC", headerBg:"#F1F5F9", headerText:"#475569", border:"#E2E8F0" },
  collecting: { dot:"#3B82F6", colBg:"#F8FBFF", headerBg:"#EFF6FF", headerText:"#1D4ED8", border:"#BFDBFE" },
  writing:    { dot:"#8B5CF6", colBg:"#FAF8FF", headerBg:"#F5F3FF", headerText:"#6D28D9", border:"#DDD6FE" },
  review:     { dot:"#F59E0B", colBg:"#FFFEF5", headerBg:"#FFFBEB", headerText:"#92400E", border:"#FDE68A" },
  published:  { dot:"#059669", colBg:"#F5FEFA", headerBg:"#ECFDF5", headerText:"#065F46", border:"#A7F3D0" },
  escalated:  { dot:"#EA580C", colBg:"#FFFCF8", headerBg:"#FFF7ED", headerText:"#9A3412", border:"#FED7AA" },
  failed:     { dot:"#DC2626", colBg:"#FFF8F8", headerBg:"#FEF2F2", headerText:"#991B1B", border:"#FECACA" },
};

// Stages always visible; failed only if populated
const PRIMARY: JobStatus[] = ["queued", "collecting", "writing", "review", "published", "escalated"];

// ── Root ──────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]               = useState<Job[]>([]);
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [recentlyMoved, setRecentlyMoved] = useState<Set<string>>(new Set());
  const [topic, setTopic]             = useState("");
  const [submitting, setSubmitting]   = useState(false);
  const [submitErr, setSubmitErr]     = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setJobs(data as Job[]);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // ── Realtime ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel("board")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const j = payload.new as Job;
            setJobs((prev) => [j, ...prev]);
            setSelectedId(j.id);
            flash(j.id);
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as Job;
            setJobs((prev) => prev.map((j) => j.id === updated.id ? updated : j));
            flash(updated.id);
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) => prev.filter((j) => j.id !== (payload.old as Job).id));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  function flash(id: string) {
    setRecentlyMoved((prev) => new Set([...prev, id]));
    setTimeout(() => {
      setRecentlyMoved((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 2600);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setSubmitting(true);
    setSubmitErr(null);
    const { error } = await supabase
      .from("jobs")
      .insert({ topic: topic.trim(), status: "queued" });
    setSubmitting(false);
    if (error) setSubmitErr(error.message);
    else setTopic("");
  };

  // ── Group by stage ─────────────────────────────────────────────────────────
  const byStage = STAGE_ORDER.reduce(
    (acc, s) => ({ ...acc, [s]: [] }),
    {} as Record<JobStatus, Job[]>
  );
  jobs.forEach((j) => byStage[j.status]?.push(j));

  const visibleCols = [
    ...PRIMARY,
    ...(byStage.failed?.length > 0 ? (["failed"] as JobStatus[]) : []),
  ];

  const selectedJob = selectedId ? jobs.find((j) => j.id === selectedId) ?? null : null;

  const running   = jobs.filter((j) => ["collecting","writing","review"].includes(j.status)).length;
  const escalated = byStage.escalated?.length ?? 0;
  const published = byStage.published?.length ?? 0;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", overflow: "hidden" }}>

      {/* ── Header ── */}
      <header style={{
        height: "54px",
        flexShrink: 0,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: "1.25rem",
        padding: "0 1.5rem",
        zIndex: 10,
      }}>
        <span style={{
          fontWeight: 800,
          fontSize: "1rem",
          color: "var(--accent)",
          letterSpacing: "-0.02em",
          flexShrink: 0,
        }}>
          Research Desk
        </span>

        <span style={{
          fontSize: "0.7rem",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          gap: "0.3rem",
          flexShrink: 0,
        }}>
          {["Collect","Write","Review"].map((s, i) => (
            <span key={s} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <span style={{ color:["#3B82F6","#8B5CF6","#F59E0B"][i], fontWeight: 600 }}>{s}</span>
              {i < 2 && <span style={{ opacity: 0.5 }}>→</span>}
            </span>
          ))}
        </span>

        {/* Live counts */}
        <div style={{ display: "flex", gap: "1rem" }}>
          {running > 0 && <LiveStat n={running} label="running" color="#3B82F6" />}
          {escalated > 0 && <LiveStat n={escalated} label="need review" color="#EA580C" />}
          {published > 0 && <LiveStat n={published} label="published" color="#059669" />}
        </div>

        {/* Submit */}
        <form onSubmit={handleSubmit} style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Enter a research topic…"
            disabled={submitting}
            style={{
              background: "var(--surface-2)",
              border: "1.5px solid var(--border)",
              borderRadius: "8px",
              padding: "0.35rem 0.8rem",
              fontSize: "0.82rem",
              color: "var(--text)",
              width: "240px",
              outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
          <button
            type="submit"
            disabled={submitting || !topic.trim()}
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "0.35rem 0.95rem",
              fontSize: "0.82rem",
              fontWeight: 700,
              cursor: submitting || !topic.trim() ? "default" : "pointer",
              opacity: submitting || !topic.trim() ? 0.45 : 1,
              letterSpacing: "-0.01em",
            }}
          >
            {submitting ? "…" : "Research →"}
          </button>
          {submitErr && (
            <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{submitErr}</span>
          )}
        </form>
      </header>

      {/* ── Kanban board ── */}
      <div style={{
        flexShrink: 0,
        borderBottom: "2px solid var(--border)",
        background: "#FAFBFD",
        overflowX: "auto",
        overflowY: "hidden",
      }}>
        <div style={{
          display: "flex",
          minWidth: "fit-content",
          height: "272px",
        }}>
          {visibleCols.map((stage, i) => {
            const conf = STAGE_CONF[stage];
            const cards = byStage[stage] ?? [];
            return (
              <div
                key={stage}
                style={{
                  minWidth: "192px",
                  maxWidth: "192px",
                  display: "flex",
                  flexDirection: "column",
                  borderRight: i < visibleCols.length - 1 ? `1px solid ${conf.border}` : "none",
                }}
              >
                {/* Column header */}
                <div style={{
                  padding: "0.55rem 0.875rem",
                  background: conf.headerBg,
                  borderBottom: `1px solid ${conf.border}`,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexShrink: 0,
                }}>
                  <span style={{
                    width: "7px", height: "7px",
                    borderRadius: "50%",
                    background: conf.dot,
                    flexShrink: 0,
                    display: "inline-block",
                  }} />
                  <span style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: conf.headerText,
                    letterSpacing: "0.04em",
                    flex: 1,
                  }}>
                    {STAGE_LABELS[stage]}
                  </span>
                  {cards.length > 0 && (
                    <span style={{
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      color: conf.headerText,
                      background: "rgba(255,255,255,0.65)",
                      padding: "0.08rem 0.4rem",
                      borderRadius: "999px",
                    }}>
                      {cards.length}
                    </span>
                  )}
                </div>

                {/* Cards */}
                <div style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "0.5rem",
                  background: conf.colBg,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                }}>
                  {cards.length === 0 ? (
                    <p style={{
                      margin: 0,
                      fontSize: "0.72rem",
                      color: "var(--text-dim)",
                      fontStyle: "italic",
                      textAlign: "center",
                      marginTop: "1.5rem",
                    }}>
                      empty
                    </p>
                  ) : (
                    cards.map((job) => (
                      <KanbanCard
                        key={job.id}
                        job={job}
                        conf={conf}
                        isSelected={selectedId === job.id}
                        justMoved={recentlyMoved.has(job.id)}
                        onClick={() => setSelectedId((p) => p === job.id ? null : job.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Detail panel ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem 1.5rem" }}>
        {selectedJob ? (
          <div style={{ maxWidth: "760px" }}>
            <div style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              marginBottom: "1.25rem",
            }}>
              <div style={{ flex: 1 }}>
                <h2 style={{
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  color: "var(--text)",
                  letterSpacing: "-0.01em",
                  margin: "0 0 0.25rem",
                  lineHeight: 1.3,
                }}>
                  {selectedJob.topic}
                </h2>
                <span style={{
                  fontSize: "0.7rem",
                  color: "var(--text-muted)",
                }}>
                  Click any card in the board above to switch jobs
                </span>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                style={{
                  background: "none", border: "none",
                  color: "var(--text-muted)", cursor: "pointer",
                  fontSize: "1.1rem", lineHeight: 1, padding: "0.2rem",
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>
            <PipelineView job={selectedJob} onDecision={loadJobs} />
          </div>
        ) : (
          <EmptyDetail count={jobs.length} />
        )}
      </div>
    </div>
  );
}

// ── Kanban card ───────────────────────────────────────────────────────────────

function KanbanCard({
  job, conf, isSelected, justMoved, onClick,
}: {
  job: Job;
  conf: typeof STAGE_CONF[string];
  isSelected: boolean;
  justMoved: boolean;
  onClick: () => void;
}) {
  const ageMin = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60_000);
  const age = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
  const isActive = ["collecting", "writing", "review"].includes(job.status);

  return (
    <button
      onClick={onClick}
      className={justMoved ? "card-arrive" : isActive ? "card-glow" : undefined}
      style={{
        width: "100%",
        textAlign: "left",
        background: "#fff",
        border: `1.5px solid ${isSelected ? "var(--accent)" : justMoved ? conf.dot : "var(--border)"}`,
        borderRadius: "8px",
        padding: "0.525rem 0.625rem",
        cursor: "pointer",
        boxShadow: isSelected
          ? "0 0 0 3px rgba(91,95,255,0.12), 0 2px 8px rgba(0,0,0,0.07)"
          : "0 1px 3px rgba(0,0,0,0.05)",
        transition: "border-color 0.2s",
      }}
    >
      <p style={{
        fontSize: "0.78rem",
        fontWeight: 600,
        color: "var(--text)",
        lineHeight: 1.35,
        margin: "0 0 0.3rem",
        overflow: "hidden",
        display: "-webkit-box" as const,
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical" as const,
      }}>
        {job.topic}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        {isActive && (
          <span
            className="dot-pulse"
            style={{
              display: "inline-block",
              width: "5px", height: "5px",
              borderRadius: "50%",
              background: conf.dot,
              flexShrink: 0,
            }}
          />
        )}
        {job.status === "published" && (
          <span style={{ fontSize: "0.65rem", color: "#059669", fontWeight: 700 }}>✓</span>
        )}
        {job.status === "escalated" && (
          <span style={{ fontSize: "0.65rem", color: "#EA580C", fontWeight: 700 }}>⚠</span>
        )}
        <span style={{ fontSize: "0.67rem", color: "var(--text-muted)" }}>{age}</span>
        {job.attempts > 0 && (
          <span style={{ fontSize: "0.67rem", color: "#F59E0B", marginLeft: "auto" }}>
            ↺{job.attempts}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Live stat chip ────────────────────────────────────────────────────────────

function LiveStat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.88rem", fontWeight: 700, color }}>{n}</span>
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

// ── Empty detail ──────────────────────────────────────────────────────────────

function EmptyDetail({ count }: { count: number }) {
  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "0.75rem",
      color: "var(--text-muted)",
      userSelect: "none",
    }}>
      <span style={{ fontSize: "2rem", opacity: 0.3 }}>◈</span>
      <p style={{ fontSize: "0.88rem", color: "var(--text-3)", margin: 0 }}>
        {count > 0
          ? "Click a card in the board above to see the pipeline"
          : "Submit a research topic above to get started"}
      </p>
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>
        Collector → Writer → Reviewer · powered by Groq
      </p>
    </div>
  );
}
