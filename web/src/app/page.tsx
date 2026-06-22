"use client";

import { useEffect, useState, useCallback } from "react";
import {
  supabase,
  STAGE_LABELS,
  type Job,
  type JobStatus,
} from "@/lib/supabase";
import { PipelineView } from "@/components/PipelineView";

// ── Stage colours & icons ─────────────────────────────────────────────────────

const STAGE_META: Record<string, { color: string; light: string; icon: string }> = {
  queued:     { color: "var(--text-muted)", light: "var(--surface-2)", icon: "○" },
  collecting: { color: "var(--blue)",       light: "var(--blue-light)",   icon: "◈" },
  writing:    { color: "var(--purple)",     light: "var(--purple-light)", icon: "✦" },
  review:     { color: "var(--amber)",      light: "var(--amber-light)",  icon: "◉" },
  published:  { color: "var(--green)",      light: "var(--green-light)",  icon: "✓" },
  escalated:  { color: "var(--orange)",     light: "var(--orange-light)", icon: "⚠" },
  failed:     { color: "var(--red)",        light: "var(--red-light)",    icon: "✗" },
};

// ── Root ──────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]           = useState<Job[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [topic, setTopic]         = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [totalPublished, setTotalPublished] = useState(0);

  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) {
      const list = data as Job[];
      setJobs(list);
      setTotalPublished(list.filter((j) => j.status === "published").length);
    }
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Realtime job updates
  useEffect(() => {
    const ch = supabase
      .channel("board-jobs")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const j = payload.new as Job;
            setJobs((prev) => [j, ...prev]);
            setExpandedId(j.id); // auto-expand newly submitted
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as Job;
            setJobs((prev) => prev.map((j) => j.id === updated.id ? updated : j));
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) => prev.filter((j) => j.id !== (payload.old as Job).id));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

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

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => prev === id ? null : id);
  };

  const active   = jobs.filter((j) => ["queued","collecting","writing","review"].includes(j.status));
  const escalated = jobs.filter((j) => j.status === "escalated");
  const finished  = jobs.filter((j) => ["published","failed"].includes(j.status));

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* ── Header ── */}
      <header style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{
          maxWidth: "900px",
          margin: "0 auto",
          padding: "0 1.5rem",
          height: "58px",
          display: "flex",
          alignItems: "center",
          gap: "1.5rem",
        }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
            <span style={{
              fontWeight: 800,
              fontSize: "1.05rem",
              color: "var(--accent)",
              letterSpacing: "-0.01em",
              fontFamily: "var(--font-dm, sans-serif)",
            }}>
              Research Desk
            </span>
            <span style={{
              fontSize: "0.68rem",
              color: "var(--text-muted)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              padding: "0.15rem 0.5rem",
              borderRadius: "999px",
              letterSpacing: "0.02em",
            }}>
              3 agents · live
            </span>
          </div>

          {/* Live stats */}
          <div style={{ display: "flex", gap: "1rem", marginLeft: "0.5rem" }}>
            {active.length > 0 && (
              <Stat
                value={active.length}
                label={active.length === 1 ? "running" : "running"}
                color="var(--blue)"
              />
            )}
            {escalated.length > 0 && (
              <Stat value={escalated.length} label="needs review" color="var(--orange)" />
            )}
            <Stat value={totalPublished} label="published" color="var(--green)" />
          </div>

          {/* Submit form */}
          <form
            onSubmit={handleSubmit}
            style={{ display: "flex", gap: "0.5rem", marginLeft: "auto", alignItems: "center" }}
          >
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Research topic…"
              disabled={submitting}
              style={{
                background: "var(--surface-2)",
                border: "1.5px solid var(--border)",
                borderRadius: "8px",
                padding: "0.4rem 0.875rem",
                fontSize: "0.83rem",
                color: "var(--text)",
                width: "230px",
                outline: "none",
                transition: "border-color 0.15s",
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
                padding: "0.4rem 1rem",
                fontSize: "0.83rem",
                fontWeight: 600,
                cursor: submitting || !topic.trim() ? "default" : "pointer",
                opacity: submitting || !topic.trim() ? 0.45 : 1,
                whiteSpace: "nowrap",
                letterSpacing: "-0.01em",
              }}
            >
              {submitting ? "…" : "Research →"}
            </button>
            {submitErr && (
              <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{submitErr}</span>
            )}
          </form>
        </div>
      </header>

      {/* ── Content ── */}
      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "2rem 1.5rem 4rem" }}>

        {jobs.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {/* Section label: active/escalated first */}
            {(active.length > 0 || escalated.length > 0) && (
              <SectionLabel>In Progress</SectionLabel>
            )}
            {[...active, ...escalated].map((job) => (
              <JobAccordion
                key={job.id}
                job={job}
                isOpen={expandedId === job.id}
                onToggle={() => toggleExpand(job.id)}
                onDecision={loadJobs}
              />
            ))}

            {/* Finished jobs */}
            {finished.length > 0 && (
              <>
                <SectionLabel style={{ marginTop: active.length > 0 || escalated.length > 0 ? "1.25rem" : 0 }}>
                  Completed
                </SectionLabel>
                {finished.map((job) => (
                  <JobAccordion
                    key={job.id}
                    job={job}
                    isOpen={expandedId === job.id}
                    onToggle={() => toggleExpand(job.id)}
                    onDecision={loadJobs}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{
      fontSize: "0.7rem",
      fontWeight: 700,
      letterSpacing: "0.12em",
      color: "var(--text-muted)",
      textTransform: "uppercase",
      marginBottom: "0.1rem",
      ...style,
    }}>
      {children}
    </p>
  );
}

// ── Stat chip ─────────────────────────────────────────────────────────────────

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem" }}>
      <span style={{ fontSize: "0.88rem", fontWeight: 700, color }}>{value}</span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

// ── Job accordion card ────────────────────────────────────────────────────────

function JobAccordion({
  job, isOpen, onToggle, onDecision,
}: {
  job: Job;
  isOpen: boolean;
  onToggle: () => void;
  onDecision: () => void;
}) {
  const meta = STAGE_META[job.status] ?? STAGE_META.queued;
  const ageMin = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60_000);
  const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;

  const isTerminal = ["published", "failed"].includes(job.status);

  return (
    <div style={{
      background: "var(--surface)",
      borderRadius: "12px",
      border: `1.5px solid ${isOpen ? "var(--accent)" : "var(--border)"}`,
      overflow: "hidden",
      boxShadow: isOpen
        ? "0 0 0 3px rgba(91,95,255,0.08), 0 4px 16px rgba(0,0,0,0.06)"
        : "0 1px 4px rgba(0,0,0,0.04)",
      transition: "border-color 0.15s, box-shadow 0.15s",
    }}>
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          padding: "1rem 1.25rem",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {/* Expand chevron */}
        <span style={{
          fontSize: "0.7rem",
          color: "var(--text-muted)",
          transform: isOpen ? "rotate(90deg)" : "rotate(0)",
          transition: "transform 0.18s ease",
          flexShrink: 0,
        }}>
          ▶
        </span>

        {/* Topic */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "var(--text)",
            lineHeight: 1.35,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            letterSpacing: "-0.01em",
          }}>
            {job.topic}
          </p>
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
            {age}
            {job.attempts > 0 && (
              <span style={{ color: "var(--amber)", marginLeft: "0.5rem" }}>
                ↺ {job.attempts} {job.attempts === 1 ? "retry" : "retries"}
              </span>
            )}
          </p>
        </div>

        {/* Mini pipeline diagram */}
        <MiniPipeline status={job.status} />

        {/* Status badge */}
        <span style={{
          flexShrink: 0,
          fontSize: "0.72rem",
          fontWeight: 600,
          color: meta.color,
          background: meta.light,
          padding: "0.22rem 0.625rem",
          borderRadius: "999px",
          letterSpacing: "0.01em",
        }}>
          {STAGE_LABELS[job.status]}
        </span>
      </button>

      {/* Expanded pipeline */}
      {isOpen && (
        <div
          className="pipeline-expand"
          style={{
            borderTop: "1px solid var(--border)",
            padding: "1.25rem 1.5rem 1.5rem",
          }}
        >
          <PipelineView job={job} onDecision={onDecision} />
        </div>
      )}
    </div>
  );
}

// ── Mini pipeline diagram ─────────────────────────────────────────────────────

function MiniPipeline({ status }: { status: JobStatus }) {
  const collectDone   = ["writing","review","published","escalated"].includes(status);
  const collectActive = status === "collecting";
  const writeDone     = ["review","published","escalated"].includes(status);
  const writeActive   = status === "writing";
  const reviewDone    = ["published","escalated"].includes(status);
  const reviewActive  = status === "review";

  const nodeStyle = (done: boolean, active: boolean, color: string, lightColor: string) => ({
    width: "24px",
    height: "24px",
    borderRadius: "50%",
    border: `2px solid ${done ? "var(--green)" : active ? color : "var(--border)"}`,
    background: done ? "var(--green-light)" : active ? lightColor : "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.6rem",
    fontWeight: 700,
    color: done ? "var(--green)" : active ? color : "var(--text-dim)",
    flexShrink: 0,
    transition: "all 0.2s",
  });

  const trackStyle = (filled: boolean) => ({
    flex: 1,
    height: "2px",
    background: filled ? "var(--green)" : "var(--border)",
    borderRadius: "1px",
    minWidth: "20px",
    transition: "background 0.3s",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, gap: "0" }}>
      <div
        className={collectActive ? "node-active" : undefined}
        style={nodeStyle(collectDone, collectActive, "var(--blue)", "var(--blue-light)")}
      >
        {collectDone ? "✓" : "◈"}
      </div>
      <div style={trackStyle(collectDone)} />
      <div
        className={writeActive ? "node-active" : undefined}
        style={nodeStyle(writeDone, writeActive, "var(--purple)", "var(--purple-light)")}
      >
        {writeDone ? "✓" : "✦"}
      </div>
      <div style={trackStyle(writeDone)} />
      <div
        className={reviewActive ? "node-active" : undefined}
        style={nodeStyle(reviewDone, reviewActive, "var(--amber)", "var(--amber-light)")}
      >
        {reviewDone ? "✓" : "◉"}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      textAlign: "center",
      padding: "5rem 1rem",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "1rem",
    }}>
      <div style={{
        width: "56px",
        height: "56px",
        borderRadius: "16px",
        background: "var(--accent-light)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "1.5rem",
        color: "var(--accent)",
      }}>
        ◈
      </div>
      <div>
        <p style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--text)", marginBottom: "0.375rem" }}>
          No research jobs yet
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
          Enter a topic above — three agents will collect sources, write a brief, and review it.
        </p>
      </div>
      <div style={{
        display: "flex",
        gap: "0.5rem",
        marginTop: "0.5rem",
        fontSize: "0.78rem",
        color: "var(--text-muted)",
        alignItems: "center",
      }}>
        <AgentChip icon="◈" label="Collector" color="var(--blue)" />
        <span style={{ color: "var(--text-dim)" }}>→</span>
        <AgentChip icon="✦" label="Writer" color="var(--purple)" />
        <span style={{ color: "var(--text-dim)" }}>→</span>
        <AgentChip icon="◉" label="Reviewer" color="var(--amber)" />
      </div>
    </div>
  );
}

function AgentChip({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.3rem",
      padding: "0.25rem 0.625rem",
      borderRadius: "999px",
      border: "1.5px solid var(--border)",
      background: "var(--surface)",
      color,
      fontWeight: 500,
      fontSize: "0.78rem",
    }}>
      <span>{icon}</span>
      <span style={{ color: "var(--text-2)" }}>{label}</span>
    </span>
  );
}
