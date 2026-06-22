"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase, STAGE_ORDER, type Job, type JobStatus } from "@/lib/supabase";
import { ChatMessage } from "@/components/ChatMessage";

export default function ChatPage() {
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [topic, setTopic]       = useState("");
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
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobs.length]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setSubmitting(true);
    setSubmitErr(null);
    const { error } = await supabase.from("jobs").insert({ topic: topic.trim(), status: "queued" });
    setSubmitting(false);
    if (error) setSubmitErr(error.message);
    else {
      setTopic("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const counts = STAGE_ORDER.reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<JobStatus, number>);
  jobs.forEach((j) => { counts[j.status] = (counts[j.status] ?? 0) + 1; });
  const running = (counts.collecting ?? 0) + (counts.writing ?? 0) + (counts.review ?? 0);

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
        padding: "0 2rem", gap: "1rem", zIndex: 10,
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
        </div>
      </header>

      {/* ── Chat feed ──────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "2rem 1rem" }}>
        <div style={{
          maxWidth: "720px", width: "100%", margin: "0 auto",
          display: "flex", flexDirection: "column", gap: "2rem",
        }}>
          {jobs.length === 0 && <EmptyState />}
          {jobs.map((job) => (
            <ChatMessage key={job.id} job={job} onDecision={loadJobs} />
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* ── Input bar ──────────────────────────────────────────── */}
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
              placeholder="Enter a research topic…"
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
  );
}

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
