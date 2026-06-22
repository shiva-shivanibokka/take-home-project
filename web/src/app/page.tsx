"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase, STAGE_ORDER, type Job, type JobStatus } from "@/lib/supabase";
import { ChatMessage } from "@/components/ChatMessage";

// ── Root ──────────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [jobs, setJobs]             = useState<Job[]>([]);
  const [liveJobId, setLiveJobId]   = useState<string | null>(null);
  const [mode, setMode]             = useState<"live" | "history">("live");
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [topic, setTopic]           = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr]   = useState<string | null>(null);
  const chatEndRef  = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: true });
    if (data) setJobs(data as Job[]);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    const ch = supabase
      .channel("chat-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, (payload) => {
        if (payload.eventType === "INSERT") {
          setJobs((prev) => [...prev, payload.new as Job]);
        } else if (payload.eventType === "UPDATE") {
          const updated = payload.new as Job;
          setJobs((prev) => prev.map((j) => j.id === updated.id ? updated : j));
        } else if (payload.eventType === "DELETE") {
          setJobs((prev) => prev.filter((j) => j.id !== (payload.old as Job).id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Scroll chat to bottom when live job changes
  useEffect(() => {
    if (mode === "live") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveJobId, mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setSubmitting(true);
    setSubmitErr(null);
    const { data, error } = await supabase
      .from("jobs")
      .insert({ topic: topic.trim(), status: "queued" })
      .select()
      .single();
    setSubmitting(false);
    if (error) { setSubmitErr(error.message); return; }
    if (data) setLiveJobId(data.id);
    setMode("live");
    setTopic("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  // Counts for header
  const counts = STAGE_ORDER.reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<JobStatus, number>);
  jobs.forEach((j) => { counts[j.status] = (counts[j.status] ?? 0) + 1; });
  const running = (counts.collecting ?? 0) + (counts.writing ?? 0) + (counts.review ?? 0);

  // Sidebar: completed jobs
  const completedJobs = jobs.filter((j) => ["published", "escalated", "failed"].includes(j.status));

  // Chat panel: which job to show
  const liveJob    = liveJobId ? jobs.find((j) => j.id === liveJobId) ?? null : null;
  const historyJob = historyJobId ? jobs.find((j) => j.id === historyJobId) ?? null : null;
  const displayJob = mode === "history" ? historyJob : liveJob;

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "#F7F8FA", overflow: "hidden",
    }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <header style={{
        height: "52px", flexShrink: 0,
        background: "rgba(255,255,255,0.96)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #E4E8F0",
        display: "flex", alignItems: "center",
        padding: "0 1.75rem", gap: "1rem", zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <div style={{
            width: "24px", height: "24px", borderRadius: "6px",
            background: "linear-gradient(135deg, #4361EE 0%, #8B5CF6 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: "11px",
          }}>R</div>
          <span style={{ fontWeight: 800, fontSize: "0.95rem", color: "#0D0F12", letterSpacing: "-0.025em" }}>
            Research Desk
          </span>
        </div>
        <span style={{ fontSize: "0.75rem", color: "#CBD5E1" }}>
          Collector → Writer → Reviewer
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "1.25rem", alignItems: "center" }}>
          {running > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.78rem", color: "#4361EE", fontWeight: 600 }}>
              <span className="dot-pulse" style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#4361EE" }} />
              {running} running
            </span>
          )}
          {(counts.published ?? 0) > 0 && (
            <span style={{ fontSize: "0.78rem", color: "#059669", fontWeight: 600 }}>
              {counts.published} published
            </span>
          )}
          {(counts.escalated ?? 0) > 0 && (
            <span style={{ fontSize: "0.78rem", color: "#EA580C", fontWeight: 600 }}>
              {counts.escalated} need review
            </span>
          )}
          {(counts.failed ?? 0) > 0 && (
            <span style={{ fontSize: "0.78rem", color: "#DC2626", fontWeight: 600 }}>
              {counts.failed} failed
            </span>
          )}
        </div>
      </header>

      {/* ── Body: sidebar + chat ────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Sidebar ── */}
        <Sidebar
          jobs={completedJobs}
          selectedId={mode === "history" ? historyJobId : null}
          onSelect={(id) => { setHistoryJobId(id); setMode("history"); }}
        />

        {/* ── Chat column ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Chat area */}
          <div style={{ flex: 1, overflowY: "auto", padding: "2rem 1rem" }}>
            <div style={{ maxWidth: "720px", width: "100%", margin: "0 auto" }}>

              {/* History mode: back button */}
              {mode === "history" && (
                <button
                  onClick={() => setMode("live")}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "0.375rem",
                    background: "none", border: "none",
                    color: "#64748B", fontSize: "0.8rem", fontWeight: 600,
                    cursor: "pointer", padding: "0 0 1.25rem",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#4361EE"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "#64748B"; }}
                >
                  ← Back to live
                </button>
              )}

              {/* Job display */}
              {displayJob ? (
                <ChatMessage key={displayJob.id} job={displayJob} onDecision={loadJobs} />
              ) : (
                <EmptyState />
              )}

              <div ref={chatEndRef} />
            </div>
          </div>

          {/* Input bar */}
          <div style={{
            flexShrink: 0,
            background: "rgba(255,255,255,0.96)", backdropFilter: "blur(12px)",
            borderTop: "1px solid #E4E8F0",
            padding: "1rem 1rem 1.375rem",
          }}>
            <form onSubmit={handleSubmit} style={{ maxWidth: "720px", margin: "0 auto" }}>
              <div style={{
                display: "flex", gap: "0.625rem", alignItems: "flex-end",
                background: "#fff", border: "1.5px solid #D1D9E6", borderRadius: "14px",
                padding: "0.625rem 0.625rem 0.625rem 1.125rem",
                boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
              }}>
                <textarea
                  ref={textareaRef}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onInput={(e) => {
                    const t = e.currentTarget;
                    t.style.height = "auto";
                    t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
                  }}
                  placeholder={mode === "history" ? "Start a new research topic…" : "Enter a research topic…"}
                  disabled={submitting}
                  rows={1}
                  style={{
                    flex: 1, background: "none", border: "none", outline: "none",
                    resize: "none", fontSize: "0.93rem", color: "#0D0F12",
                    lineHeight: 1.55, fontFamily: "inherit",
                    maxHeight: "120px", overflowY: "auto",
                  }}
                />
                <button
                  type="submit"
                  disabled={submitting || !topic.trim()}
                  style={{
                    flexShrink: 0, width: "36px", height: "36px", borderRadius: "10px",
                    background: (submitting || !topic.trim()) ? "#E4E8F0" : "#4361EE",
                    border: "none",
                    cursor: (submitting || !topic.trim()) ? "default" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: (submitting || !topic.trim()) ? "#94A3B8" : "#fff",
                    fontSize: "1.05rem", fontWeight: 700,
                    transition: "background 0.15s",
                  }}
                >
                  {submitting ? "…" : "↑"}
                </button>
              </div>
              {submitErr && (
                <p style={{ margin: "0.375rem 0 0", fontSize: "0.75rem", color: "#DC2626" }}>{submitErr}</p>
              )}
              <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "#94A3B8", textAlign: "center" }}>
                Enter to research · Shift+Enter for new line
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ jobs, selectedId, onSelect }: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    published: true,
    escalated: true,
    failed: false,
  });

  const toggle = (key: string) =>
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  const sections = [
    {
      key: "published", label: "Published",
      color: "#059669", dimColor: "#ECFDF5", border: "#A7F3D0",
      jobs: jobs.filter((j) => j.status === "published"),
    },
    {
      key: "escalated", label: "Needs Human",
      color: "#EA580C", dimColor: "#FFF7ED", border: "#FED7AA",
      jobs: jobs.filter((j) => j.status === "escalated"),
    },
    {
      key: "failed", label: "Failed",
      color: "#DC2626", dimColor: "#FEF2F2", border: "#FECACA",
      jobs: jobs.filter((j) => j.status === "failed"),
    },
  ];

  return (
    <div style={{
      width: "290px", flexShrink: 0,
      borderRight: "1px solid #E4E8F0",
      background: "#FAFBFE",
      display: "flex", flexDirection: "column",
      overflowY: "auto",
    }}>
      {/* Sidebar header */}
      <div style={{
        padding: "0.75rem 1rem",
        borderBottom: "1px solid #E4E8F0",
        flexShrink: 0,
      }}>
        <p style={{
          margin: 0, fontSize: "0.68rem", fontWeight: 700,
          letterSpacing: "0.08em", color: "#94A3B8",
        }}>
          COMPLETED JOBS
        </p>
      </div>

      {/* Sections */}
      {sections.map((section) => (
        <div key={section.key}>
          {/* Section toggle */}
          <button
            onClick={() => toggle(section.key)}
            style={{
              width: "100%", background: "none", border: "none",
              display: "flex", alignItems: "center", gap: "0.5rem",
              padding: "0.625rem 1rem", cursor: "pointer",
              borderBottom: `1px solid #F1F5F9`,
              textAlign: "left",
            }}
          >
            <span style={{
              display: "inline-block",
              transform: open[section.key] ? "rotate(90deg)" : "rotate(0)",
              transition: "transform 0.15s",
              fontSize: "0.55rem", color: "#CBD5E1", flexShrink: 0,
            }}>▶</span>
            <span style={{ fontSize: "0.75rem", fontWeight: 700, color: section.color, flex: 1 }}>
              {section.label}
            </span>
            {section.jobs.length > 0 && (
              <span style={{
                fontSize: "0.65rem", fontWeight: 700,
                background: section.dimColor, color: section.color,
                padding: "0.1rem 0.45rem", borderRadius: "999px",
              }}>
                {section.jobs.length}
              </span>
            )}
          </button>

          {/* Job rows */}
          {open[section.key] && (
            <div>
              {section.jobs.length === 0 ? (
                <p style={{
                  margin: 0, padding: "0.625rem 1rem 0.625rem 2rem",
                  fontSize: "0.73rem", color: "#CBD5E1", fontStyle: "italic",
                }}>
                  None yet
                </p>
              ) : (
                section.jobs.slice().reverse().map((job) => {
                  const isSelected = selectedId === job.id;
                  const ageMin = Math.round(
                    (Date.now() - new Date(job.created_at).getTime()) / 60_000
                  );
                  const age = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
                  return (
                    <button
                      key={job.id}
                      onClick={() => onSelect(job.id)}
                      style={{
                        width: "100%", background: isSelected ? "#EEF2FF" : "none",
                        border: "none",
                        borderLeft: isSelected ? `3px solid #4361EE` : "3px solid transparent",
                        display: "flex", flexDirection: "column", gap: "0.15rem",
                        padding: "0.5rem 0.875rem 0.5rem 0.875rem",
                        cursor: "pointer", textAlign: "left",
                        borderBottom: "1px solid #F1F5F9",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "#F5F7FF";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none";
                      }}
                    >
                      <span style={{
                        fontSize: "0.78rem", fontWeight: isSelected ? 600 : 400,
                        color: isSelected ? "#1E293B" : "#374151",
                        overflow: "hidden",
                        display: "-webkit-box" as const,
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical" as const,
                        lineHeight: 1.4,
                      }}>
                        {job.topic}
                      </span>
                      <span style={{ fontSize: "0.68rem", color: "#94A3B8" }}>{age} ago</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      ))}

      {/* Empty sidebar state */}
      {jobs.length === 0 && (
        <div style={{ padding: "1.5rem 1rem", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "#CBD5E1", lineHeight: 1.6 }}>
            Completed briefs will appear here
          </p>
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "5rem 2rem", gap: "1rem",
    }}>
      <div style={{
        width: "56px", height: "56px", borderRadius: "16px",
        background: "linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 100%)",
        border: "1.5px solid #C7D2FE",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "1.5rem", color: "#4361EE",
      }}>◈</div>
      <p style={{ fontSize: "1.1rem", fontWeight: 700, color: "#1E293B", margin: 0, letterSpacing: "-0.015em" }}>
        What do you want to research?
      </p>
      <p style={{ fontSize: "0.875rem", color: "#94A3B8", margin: 0, textAlign: "center", maxWidth: "380px", lineHeight: 1.65 }}>
        Type a topic below. Three agents will collect sources, draft a brief, and review it — you&apos;ll see their reasoning in real time.
      </p>
    </div>
  );
}
