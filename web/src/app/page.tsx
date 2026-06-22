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

const STAGE_CONF: Record<string, {
  dot: string; colBg: string; headerBg: string; headerText: string; border: string;
}> = {
  queued:     { dot:"#94A3B8", colBg:"#FAFBFC", headerBg:"#F1F5F9", headerText:"#475569", border:"#E2E8F0" },
  collecting: { dot:"#4361EE", colBg:"#F6F8FF", headerBg:"#EEF2FF", headerText:"#3730A3", border:"#C7D2FE" },
  writing:    { dot:"#8B5CF6", colBg:"#FAF8FF", headerBg:"#F5F3FF", headerText:"#6D28D9", border:"#DDD6FE" },
  review:     { dot:"#F59E0B", colBg:"#FFFEF5", headerBg:"#FFFBEB", headerText:"#92400E", border:"#FDE68A" },
  published:  { dot:"#059669", colBg:"#F5FEFA", headerBg:"#ECFDF5", headerText:"#065F46", border:"#A7F3D0" },
  escalated:  { dot:"#EA580C", colBg:"#FFFCF8", headerBg:"#FFF7ED", headerText:"#9A3412", border:"#FED7AA" },
  failed:     { dot:"#DC2626", colBg:"#FFF8F8", headerBg:"#FEF2F2", headerText:"#991B1B", border:"#FECACA" },
};

const PRIMARY: JobStatus[] = ["queued", "collecting", "writing", "review", "published", "escalated"];

export default function BoardPage() {
  const [jobs, setJobs]                   = useState<Job[]>([]);
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [recentlyMoved, setRecentlyMoved] = useState<Set<string>>(new Set());
  const [topic, setTopic]                 = useState("");
  const [submitting, setSubmitting]       = useState(false);
  const [submitErr, setSubmitErr]         = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setJobs(data as Job[]);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    const ch = supabase
      .channel("board")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, (payload) => {
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
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  function flash(id: string) {
    setRecentlyMoved((prev) => new Set([...prev, id]));
    setTimeout(() => {
      setRecentlyMoved((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }, 2600);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setSubmitting(true);
    setSubmitErr(null);
    const { error } = await supabase.from("jobs").insert({ topic: topic.trim(), status: "queued" });
    setSubmitting(false);
    if (error) setSubmitErr(error.message);
    else setTopic("");
  };

  const byStage = STAGE_ORDER.reduce(
    (acc, s) => ({ ...acc, [s]: [] }),
    {} as Record<JobStatus, Job[]>
  );
  jobs.forEach((j) => byStage[j.status]?.push(j));

  const visibleCols = [...PRIMARY, ...(byStage.failed?.length > 0 ? (["failed"] as JobStatus[]) : [])];
  const selectedJob  = selectedId ? jobs.find((j) => j.id === selectedId) ?? null : null;

  const counts = STAGE_ORDER.reduce(
    (acc, s) => ({ ...acc, [s]: byStage[s]?.length ?? 0 }),
    {} as Record<JobStatus, number>
  );
  const running = (counts.collecting ?? 0) + (counts.writing ?? 0) + (counts.review ?? 0);

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "var(--bg)", overflow: "hidden",
    }}>

      {/* ── Header ──────────────────────────────────────────────── */}
      <header style={{
        height: "52px", flexShrink: 0,
        background: "rgba(255,255,255,0.95)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: "1.5rem", padding: "0 1.75rem",
        zIndex: 10,
      }}>
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
          <div style={{
            width: "24px", height: "24px", borderRadius: "6px",
            background: "linear-gradient(135deg, #4361EE 0%, #8B5CF6 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: "11px",
          }}>R</div>
          <span style={{ fontWeight: 800, fontSize: "0.95rem", color: "var(--text)", letterSpacing: "-0.025em" }}>
            Research Desk
          </span>
        </div>

        {/* Live pipeline indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", flexShrink: 0 }}>
          {[
            { key: "collecting", label: "Collect", color: "#4361EE" },
            { key: "writing",    label: "Write",   color: "#8B5CF6" },
            { key: "review",     label: "Review",  color: "#F59E0B" },
          ].map((s, i) => {
            const n = counts[s.key as JobStatus] ?? 0;
            const active = n > 0;
            return (
              <span key={s.key} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <span style={{
                  display: "flex", alignItems: "center", gap: "0.28rem",
                  fontSize: "0.72rem", fontWeight: 600,
                  color: active ? s.color : "var(--text-muted)",
                }}>
                  {active && (
                    <span className="dot-pulse" style={{
                      display: "inline-block", width: "5px", height: "5px",
                      borderRadius: "50%", background: s.color, flexShrink: 0,
                    }} />
                  )}
                  {s.label}
                  {active && <span style={{ fontWeight: 800 }}>{n}</span>}
                </span>
                {i < 2 && <span style={{ color: "var(--text-dim)", fontSize: "0.7rem" }}>→</span>}
              </span>
            );
          })}
        </div>

        {/* Aggregate stats */}
        <div style={{ display: "flex", gap: "1.25rem" }}>
          {running > 0           && <HeaderStat n={running}             label="running"     color="#4361EE" />}
          {(counts.published ?? 0) > 0 && <HeaderStat n={counts.published} label="published"   color="#059669" />}
          {(counts.escalated ?? 0) > 0  && <HeaderStat n={counts.escalated} label="need review" color="#EA580C" />}
        </div>

        {/* Submit form */}
        <form onSubmit={handleSubmit} style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text" value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Enter a research topic…"
            disabled={submitting}
            style={{
              background: "#F5F7FA", border: "1.5px solid var(--border)",
              borderRadius: "8px", padding: "0.38rem 0.875rem",
              fontSize: "0.83rem", color: "var(--text)", width: "240px", outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#4361EE"; e.currentTarget.style.background = "#fff"; }}
            onBlur={(e)  => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "#F5F7FA"; }}
          />
          <button
            type="submit"
            disabled={submitting || !topic.trim()}
            style={{
              background: "#4361EE", color: "#fff", border: "none", borderRadius: "8px",
              padding: "0.38rem 1.1rem", fontSize: "0.83rem", fontWeight: 700,
              cursor: (submitting || !topic.trim()) ? "default" : "pointer",
              opacity: (submitting || !topic.trim()) ? 0.4 : 1,
              letterSpacing: "-0.01em", whiteSpace: "nowrap",
              transition: "opacity 0.15s",
            }}
          >
            {submitting ? "…" : "Research →"}
          </button>
          {submitErr && <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{submitErr}</span>}
        </form>
      </header>

      {/* ── Kanban board ───────────────────────────────────────── */}
      <div style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "#F8F9FD",
        overflowX: "auto", overflowY: "hidden",
      }}>
        <div style={{ display: "flex", minWidth: "fit-content", height: "340px" }}>
          {visibleCols.map((stage, i) => {
            const conf  = STAGE_CONF[stage];
            const cards = byStage[stage] ?? [];
            return (
              <div key={stage} style={{
                minWidth: "210px", maxWidth: "210px", display: "flex", flexDirection: "column",
                borderRight: i < visibleCols.length - 1 ? `1px solid ${conf.border}` : "none",
              }}>
                <div style={{
                  padding: "0.65rem 1rem", background: conf.headerBg,
                  borderBottom: `1px solid ${conf.border}`,
                  display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0,
                }}>
                  <span style={{
                    width: "7px", height: "7px", borderRadius: "50%",
                    background: conf.dot, flexShrink: 0, display: "inline-block",
                  }} />
                  <span style={{
                    fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.07em",
                    color: conf.headerText, flex: 1, textTransform: "uppercase" as const,
                  }}>
                    {STAGE_LABELS[stage]}
                  </span>
                  {cards.length > 0 && (
                    <span style={{
                      fontSize: "0.65rem", fontWeight: 800, color: conf.headerText,
                      background: "rgba(255,255,255,0.7)", padding: "0.08rem 0.45rem",
                      borderRadius: "999px",
                    }}>
                      {cards.length}
                    </span>
                  )}
                </div>

                <div style={{
                  flex: 1, overflowY: "auto", padding: "0.5rem",
                  background: conf.colBg, display: "flex", flexDirection: "column", gap: "0.4rem",
                }}>
                  {cards.length === 0 ? (
                    <p style={{
                      margin: "1.25rem 0 0", textAlign: "center",
                      fontSize: "0.73rem", color: "var(--text-dim)", fontStyle: "italic",
                    }}>
                      empty
                    </p>
                  ) : (
                    cards.map((job) => (
                      <KanbanCard
                        key={job.id} job={job} conf={conf}
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

      {/* ── Detail / stats zone ─────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {selectedJob ? (
          <SelectedJobPanel job={selectedJob} onClose={() => setSelectedId(null)} onDecision={loadJobs} />
        ) : (
          <StatsPanel jobs={jobs} counts={counts} />
        )}
      </div>
    </div>
  );
}

// ── Kanban card ───────────────────────────────────────────────────────────────

function KanbanCard({ job, conf, isSelected, justMoved, onClick }: {
  job: Job;
  conf: typeof STAGE_CONF[string];
  isSelected: boolean;
  justMoved: boolean;
  onClick: () => void;
}) {
  const ageMin = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60_000);
  const age    = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
  const isActive = ["collecting", "writing", "review"].includes(job.status);

  return (
    <button
      onClick={onClick}
      className={justMoved ? "card-arrive" : isActive ? "card-glow" : undefined}
      style={{
        width: "100%", textAlign: "left",
        background: "#fff",
        border: `1.5px solid ${isSelected ? "#4361EE" : justMoved ? conf.dot : "var(--border)"}`,
        borderRadius: "9px",
        padding: "0.625rem 0.75rem",
        cursor: "pointer",
        boxShadow: isSelected
          ? "0 0 0 3px rgba(67,97,238,0.13), 0 2px 8px rgba(0,0,0,0.07)"
          : "0 1px 3px rgba(0,0,0,0.05)",
        transition: "border-color 0.18s, box-shadow 0.18s",
      }}
    >
      <p style={{
        fontSize: "0.8rem", fontWeight: 600, color: "var(--text)",
        lineHeight: 1.4, margin: "0 0 0.35rem",
        overflow: "hidden",
        display: "-webkit-box" as const,
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical" as const,
      }}>
        {job.topic}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        {isActive && (
          <span className="dot-pulse" style={{
            display: "inline-block", width: "5px", height: "5px",
            borderRadius: "50%", background: conf.dot, flexShrink: 0,
          }} />
        )}
        {job.status === "published" && <span style={{ fontSize: "0.68rem", color: "#059669", fontWeight: 700 }}>✓</span>}
        {job.status === "escalated"  && <span style={{ fontSize: "0.68rem", color: "#EA580C", fontWeight: 700 }}>⚠</span>}
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>{age}</span>
        {(job.attempts ?? 0) > 0 && (
          <span style={{ fontSize: "0.68rem", color: "#F59E0B", marginLeft: "auto" }}>↺{job.attempts}</span>
        )}
      </div>
    </button>
  );
}

// ── Header stat ───────────────────────────────────────────────────────────────

function HeaderStat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.9rem", fontWeight: 800, color }}>{n}</span>
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

// ── Selected job panel ────────────────────────────────────────────────────────

function SelectedJobPanel({ job, onClose, onDecision }: {
  job: Job; onClose: () => void; onDecision: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        padding: "0.875rem 2rem",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex", alignItems: "flex-start", gap: "1rem",
        flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <h2 style={{
            margin: "0 0 0.2rem", fontSize: "1.05rem", fontWeight: 700,
            color: "var(--text)", letterSpacing: "-0.015em", lineHeight: 1.3,
          }}>
            {job.topic}
          </h2>
          <span style={{ fontSize: "0.73rem", color: "var(--text-muted)" }}>
            Submitted {new Date(job.created_at).toLocaleString()} · click another card to switch
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "none", color: "var(--text-muted)",
            cursor: "pointer", fontSize: "1.1rem", padding: "0.15rem 0.3rem",
            borderRadius: "5px", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "1.5rem 2rem" }}>
        <PipelineView job={job} onDecision={onDecision} />
      </div>
    </div>
  );
}

// ── Stats dashboard (default panel — never empty) ─────────────────────────────

function StatsPanel({ jobs, counts }: { jobs: Job[]; counts: Record<JobStatus, number> }) {
  const running = (counts.collecting ?? 0) + (counts.writing ?? 0) + (counts.review ?? 0);

  const metrics = [
    { label: "Total jobs",  value: jobs.length,           color: "var(--text)" },
    { label: "Running now", value: running,                color: "#4361EE"    },
    { label: "Published",   value: counts.published ?? 0, color: "#059669"    },
    { label: "Need review", value: counts.escalated ?? 0, color: "#EA580C"    },
  ];

  const flowStages = [
    { key: "queued",     label: "Queued",     color: "#94A3B8" },
    { key: "collecting", label: "Collecting", color: "#4361EE" },
    { key: "writing",    label: "Writing",    color: "#8B5CF6" },
    { key: "review",     label: "Review",     color: "#F59E0B" },
    { key: "published",  label: "Published",  color: "#059669" },
  ];

  return (
    <div style={{ padding: "2rem" }}>
      {/* Metric cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: "1rem",
        maxWidth: "700px",
        marginBottom: "2.5rem",
      }}>
        {metrics.map((m) => (
          <div key={m.label} style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "12px", padding: "1.25rem 1.5rem",
            boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
          }}>
            <div style={{ fontSize: "2.25rem", fontWeight: 800, color: m.color, lineHeight: 1, marginBottom: "0.4rem" }}>
              {m.value}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontWeight: 500 }}>{m.label}</div>
          </div>
        ))}
      </div>

      {/* Pipeline flow */}
      <p style={{
        fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.09em",
        color: "var(--text-muted)", textTransform: "uppercase" as const, margin: "0 0 0.875rem",
      }}>
        Pipeline flow
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0", flexWrap: "wrap", rowGap: "0.75rem", marginBottom: "2rem" }}>
        {flowStages.map((s, i) => {
          const count  = counts[s.key as JobStatus] ?? 0;
          const active = count > 0;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "0.9rem 1.5rem",
                background: active ? `${s.color}14` : "var(--surface)",
                border: `1.5px solid ${active ? s.color : "var(--border)"}`,
                borderRadius: "10px", minWidth: "100px",
                transition: "all 0.3s ease",
              }}>
                <div style={{ fontSize: "2rem", fontWeight: 800, lineHeight: 1, color: active ? s.color : "var(--text-dim)" }}>
                  {count}
                </div>
                <div style={{
                  fontSize: "0.67rem", fontWeight: 700, letterSpacing: "0.07em",
                  color: active ? s.color : "var(--text-muted)",
                  marginTop: "0.3rem", textTransform: "uppercase" as const,
                }}>
                  {s.label}
                </div>
              </div>
              {i < flowStages.length - 1 && (
                <div style={{
                  width: "36px", height: "2px", flexShrink: 0,
                  background: active
                    ? `linear-gradient(90deg, ${s.color}88, ${flowStages[i + 1].color}44)`
                    : "var(--border)",
                  transition: "background 0.4s",
                }} />
              )}
            </div>
          );
        })}
        {(counts.escalated ?? 0) > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginLeft: "1.5rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 700 }}>↗</span>
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "0.9rem 1.25rem", borderRadius: "10px",
              background: "#FFF7ED", border: "1.5px solid #EA580C", minWidth: "90px",
            }}>
              <div style={{ fontSize: "2rem", fontWeight: 800, color: "#EA580C", lineHeight: 1 }}>{counts.escalated}</div>
              <div style={{ fontSize: "0.67rem", fontWeight: 700, color: "#EA580C", letterSpacing: "0.07em", marginTop: "0.3rem" }}>
                ESCALATED
              </div>
            </div>
          </div>
        )}
      </div>

      <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
        {jobs.length > 0
          ? "Select any card in the board above to view the full pipeline — sources, reasoning, brief, and reviewer verdict."
          : "Submit a research topic above. The agents will collect sources, draft a brief, and review it automatically."}
      </p>
    </div>
  );
}
