"use client";

import { useEffect, useState, useCallback } from "react";
import {
  supabase,
  STAGE_LABELS,
  type Job,
  type JobStatus,
} from "@/lib/supabase";
import { PipelineView } from "@/components/PipelineView";

// ── Status colour map ─────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  queued:     "var(--text-muted)",
  collecting: "var(--accent)",
  writing:    "var(--purple)",
  review:     "var(--amber)",
  published:  "var(--green)",
  escalated:  "var(--orange)",
  failed:     "var(--red)",
};

// ── Root ─────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [topic, setTopic]       = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr]   = useState<string | null>(null);

  // ── Load jobs ────────────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setJobs(data as Job[]);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // ── Realtime ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel("board-jobs")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setJobs((prev) => [payload.new as Job, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as Job;
            setJobs((prev) => prev.map((j) => j.id === updated.id ? updated : j));
            setSelected((prev) => prev?.id === updated.id ? updated : prev);
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) => prev.filter((j) => j.id !== (payload.old as Job).id));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────────
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

  // ── Group jobs ────────────────────────────────────────────────────────────────
  const active    = jobs.filter((j) => ["queued","collecting","writing","review"].includes(j.status));
  const escalated = jobs.filter((j) => j.status === "escalated");
  const published = jobs.filter((j) => j.status === "published");
  const failed    = jobs.filter((j) => j.status === "failed");

  const totalTokenDisplay = jobs.length;

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg)",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <header style={{
        height: "50px",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "1.25rem",
        padding: "0 1.25rem",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
          <span style={{ color: "var(--accent)", fontSize: "1.1rem", lineHeight: 1 }}>◈</span>
          <span style={{
            fontFamily: "var(--font-space, sans-serif)",
            fontWeight: 700,
            fontSize: "0.88rem",
            color: "var(--text)",
            letterSpacing: "0.06em",
          }}>
            RESEARCH DESK
          </span>
        </div>

        <span style={{
          fontSize: "0.68rem",
          color: "var(--text-muted)",
          borderLeft: "1px solid var(--border)",
          paddingLeft: "1.25rem",
          flexShrink: 0,
        }}>
          Collector → Writer → Reviewer
        </span>

        {/* Submit form */}
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", gap: "0.5rem", marginLeft: "auto", alignItems: "center" }}
        >
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Enter a research topic…"
            disabled={submitting}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border-2)",
              borderRadius: "6px",
              padding: "0.35rem 0.75rem",
              fontSize: "0.78rem",
              color: "var(--text)",
              width: "270px",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={submitting || !topic.trim()}
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "0.35rem 0.875rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              cursor: submitting || !topic.trim() ? "default" : "pointer",
              opacity: submitting || !topic.trim() ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {submitting ? "…" : "Research →"}
          </button>
          {submitErr && (
            <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{submitErr}</span>
          )}
        </form>
      </header>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Sidebar ── */}
        <aside style={{
          width: "268px",
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}>
          <JobGroup
            label="In Progress"
            dot="var(--accent)"
            pulse
            jobs={active}
            selected={selected}
            onSelect={setSelected}
          />
          <JobGroup
            label="Needs Human"
            dot="var(--orange)"
            jobs={escalated}
            selected={selected}
            onSelect={setSelected}
          />
          <JobGroup
            label="Published"
            dot="var(--green)"
            jobs={published}
            selected={selected}
            onSelect={setSelected}
          />
          <JobGroup
            label="Failed"
            dot="var(--red)"
            jobs={failed}
            selected={selected}
            onSelect={setSelected}
          />

          {/* Footer stats */}
          <div style={{
            marginTop: "auto",
            padding: "0.75rem 1rem",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.7rem",
              color: "var(--text-muted)",
            }}>
              <span>{published.length} published</span>
              <span>{escalated.length} escalated</span>
              <span>{jobs.length} total</span>
            </div>
            <div style={{ fontSize: "0.67rem", color: "var(--text-dim)" }}>
              Live · Groq llama-3.1-8b-instant
            </div>
          </div>
        </aside>

        {/* ── Main ── */}
        <main style={{
          flex: 1,
          overflowY: "auto",
          padding: "1.75rem 2rem",
        }}>
          {selected ? (
            <PipelineView job={selected} onDecision={loadJobs} />
          ) : (
            <EmptyState count={jobs.length} />
          )}
        </main>
      </div>
    </div>
  );
}

// ── Job group ─────────────────────────────────────────────────────────────────

function JobGroup({
  label, dot, pulse, jobs, selected, onSelect,
}: {
  label: string;
  dot: string;
  pulse?: boolean;
  jobs: Job[];
  selected: Job | null;
  onSelect: (j: Job) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <div style={{ paddingTop: "0.875rem", paddingBottom: "0.25rem" }}>
      <div style={{
        padding: "0 1rem 0.375rem",
        fontSize: "0.64rem",
        fontWeight: 700,
        letterSpacing: "0.12em",
        color: "var(--text-muted)",
        textTransform: "uppercase",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}>
        <span style={{
          display: "inline-block",
          width: "5px",
          height: "5px",
          borderRadius: "50%",
          background: dot,
          flexShrink: 0,
          ...(pulse ? { boxShadow: `0 0 0 2px ${dot}30` } : {}),
        }} />
        {label}
        <span style={{ marginLeft: "auto", opacity: 0.6, fontWeight: 400 }}>
          {jobs.length}
        </span>
      </div>
      {jobs.map((job) => (
        <JobItem
          key={job.id}
          job={job}
          isSelected={selected?.id === job.id}
          onClick={() => onSelect(job)}
        />
      ))}
    </div>
  );
}

// ── Job item ──────────────────────────────────────────────────────────────────

function JobItem({ job, isSelected, onClick }: {
  job: Job;
  isSelected: boolean;
  onClick: () => void;
}) {
  const ageMin = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60_000);
  const age = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;

  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "0.45rem 1rem",
        background: isSelected ? "rgba(75,158,245,0.08)" : "transparent",
        border: "none",
        borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      <div style={{
        fontSize: "0.78rem",
        fontWeight: isSelected ? 500 : 400,
        color: isSelected ? "var(--text)" : "var(--text-2)",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {job.topic}
      </div>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        marginTop: "0.15rem",
      }}>
        <span style={{
          fontSize: "0.67rem",
          color: STATUS_COLOR[job.status] ?? "var(--text-muted)",
        }}>
          {STAGE_LABELS[job.status]}
        </span>
        <span style={{ fontSize: "0.67rem", color: "var(--text-dim)" }}>·</span>
        <span style={{ fontSize: "0.67rem", color: "var(--text-muted)" }}>{age} ago</span>
        {job.attempts > 0 && (
          <span style={{ fontSize: "0.67rem", color: "var(--amber)", marginLeft: "auto" }}>
            ↺ {job.attempts}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ count }: { count: number }) {
  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "0.75rem",
      userSelect: "none",
    }}>
      <span style={{ fontSize: "2.5rem", color: "var(--text-dim)" }}>◈</span>
      <p style={{ fontSize: "0.88rem", color: "var(--text-2)" }}>
        {count > 0 ? "Select a job from the sidebar" : "Submit a topic to get started"}
      </p>
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
        Multi-agent pipeline · Collector → Writer → Reviewer
      </p>
    </div>
  );
}
