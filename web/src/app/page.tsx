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
  dot: string; rowBg: string; labelBg: string; labelText: string; border: string; icon: string;
}> = {
  queued:     { dot:"#94A3B8", rowBg:"#FAFBFC", labelBg:"#F1F5F9", labelText:"#475569", border:"#E2E8F0", icon:"○" },
  collecting: { dot:"#4361EE", rowBg:"#F6F8FF", labelBg:"#EEF2FF", labelText:"#3730A3", border:"#C7D2FE", icon:"◈" },
  writing:    { dot:"#8B5CF6", rowBg:"#FAF8FF", labelBg:"#F5F3FF", labelText:"#6D28D9", border:"#DDD6FE", icon:"✦" },
  review:     { dot:"#F59E0B", rowBg:"#FFFEF5", labelBg:"#FFFBEB", labelText:"#92400E", border:"#FDE68A", icon:"◉" },
  published:  { dot:"#059669", rowBg:"#F5FEFA", labelBg:"#ECFDF5", labelText:"#065F46", border:"#A7F3D0", icon:"✓" },
  escalated:  { dot:"#EA580C", rowBg:"#FFFCF8", labelBg:"#FFF7ED", labelText:"#9A3412", border:"#FED7AA", icon:"⚠" },
  failed:     { dot:"#DC2626", rowBg:"#FFF8F8", labelBg:"#FEF2F2", labelText:"#991B1B", border:"#FECACA", icon:"✗" },
};

const PRIMARY: JobStatus[] = ["queued", "collecting", "writing", "review", "published", "escalated"];

// ── Root ──────────────────────────────────────────────────────────────────────

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

  const visibleRows = [...PRIMARY, ...(byStage.failed?.length > 0 ? (["failed"] as JobStatus[]) : [])];
  const selectedJob = selectedId ? jobs.find((j) => j.id === selectedId) ?? null : null;

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

      {/* ── Header ─────────────────────────────────────────────── */}
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

        {/* Live stats — only shown when there's something to say */}
        <div style={{ display: "flex", gap: "1.25rem" }}>
          {running > 0             && <HeaderStat n={running}             label="running"     color="#4361EE" />}
          {(counts.published ?? 0) > 0 && <HeaderStat n={counts.published} label="published"   color="#059669" />}
          {(counts.escalated ?? 0) > 0  && <HeaderStat n={counts.escalated} label="need review" color="#EA580C" />}
          {jobs.length === 0 && (
            <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              No jobs yet — submit one to the right
            </span>
          )}
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

      {/* ── Content area ───────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* ── Swimlane board ─────────────────────────────────────── */}
        <div style={{
          flexShrink: 0, borderBottom: "2px solid var(--border)",
          overflowY: "auto", maxHeight: "calc(50vh - 26px)",
        }}>
          {visibleRows.map((stage, i) => {
            const conf  = STAGE_CONF[stage];
            const cards = byStage[stage] ?? [];
            const isLast = i === visibleRows.length - 1;

            return (
              <div
                key={stage}
                style={{
                  display: "flex",
                  borderBottom: isLast ? "none" : `1px solid ${conf.border}`,
                  minHeight: "72px",
                }}
              >
                {/* Stage label — left column */}
                <div style={{
                  width: "168px",
                  flexShrink: 0,
                  background: conf.labelBg,
                  borderRight: `2px solid ${conf.border}`,
                  padding: "0.875rem 1.125rem",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: "0.2rem",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "0.85rem", color: conf.dot, flexShrink: 0 }}>{conf.icon}</span>
                    <span style={{
                      fontSize: "0.82rem", fontWeight: 800,
                      color: conf.labelText, letterSpacing: "0.02em",
                    }}>
                      {STAGE_LABELS[stage]}
                    </span>
                  </div>
                  <div style={{
                    fontSize: "0.7rem", fontWeight: 600,
                    color: cards.length > 0 ? conf.dot : "var(--text-dim)",
                    paddingLeft: "1.5rem",
                  }}>
                    {cards.length === 0 ? "empty" : `${cards.length} job${cards.length !== 1 ? "s" : ""}`}
                  </div>
                </div>

                {/* Horizontal card strip — right */}
                <div style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.5rem 0.875rem",
                  overflowX: "auto",
                  background: conf.rowBg,
                }}>
                  {cards.length === 0 ? (
                    <p style={{
                      margin: 0, fontSize: "0.75rem",
                      color: "var(--text-dim)", fontStyle: "italic",
                    }}>
                      —
                    </p>
                  ) : (
                    cards.map((job) => (
                      <SwimlaneCard
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

        {/* ── Detail / stats zone ─────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {selectedJob ? (
            <SelectedJobPanel job={selectedJob} onClose={() => setSelectedId(null)} onDecision={loadJobs} />
          ) : (
            <StatsPanel jobs={jobs} counts={counts} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Swimlane card (horizontal filmstrip style) ─────────────────────────────────

function SwimlaneCard({ job, conf, isSelected, justMoved, onClick }: {
  job: Job;
  conf: typeof STAGE_CONF[string];
  isSelected: boolean;
  justMoved: boolean;
  onClick: () => void;
}) {
  const ageMin   = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60_000);
  const age      = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
  const isActive = ["collecting", "writing", "review"].includes(job.status);

  return (
    <button
      onClick={onClick}
      className={justMoved ? "card-arrive" : isActive ? "card-glow" : undefined}
      style={{
        flexShrink: 0,
        width: "175px",
        textAlign: "left",
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
        fontSize: "0.78rem", fontWeight: 600, color: "var(--text)",
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

// ── Stats dashboard (default — never empty) ───────────────────────────────────

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

      {/* Pipeline flow diagram */}
      <p style={{
        fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.09em",
        color: "var(--text-muted)", textTransform: "uppercase" as const, margin: "0 0 0.875rem",
      }}>
        Pipeline flow
      </p>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: "0.75rem", marginBottom: "2rem" }}>
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
