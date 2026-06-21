"use client";

import { useEffect, useState, useCallback } from "react";
import {
  supabase, STAGE_ORDER, STAGE_LABELS, STAGE_COLORS,
  type Job, type JobStatus, type Handoff, type Event,
} from "@/lib/supabase";
import { JobDrawer } from "@/components/JobDrawer";
import { SubmitForm } from "@/components/SubmitForm";
import { StatsBar } from "@/components/StatsBar";

export default function BoardPage() {
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);

  // ── Load all jobs ─────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setJobs(data as Job[]);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // ── Supabase realtime — board updates live ────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel("board-jobs")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setJobs((prev) => [payload.new as Job, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setJobs((prev) =>
              prev.map((j) => j.id === (payload.new as Job).id ? payload.new as Job : j)
            );
            // If the selected job was updated, refresh it
            setSelected((prev) =>
              prev?.id === (payload.new as Job).id ? payload.new as Job : prev
            );
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) => prev.filter((j) => j.id !== (payload.old as Job).id));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ── Group jobs by stage ───────────────────────────────────────────────────
  const byStage: Record<JobStatus, Job[]> = STAGE_ORDER.reduce(
    (acc, s) => ({ ...acc, [s]: [] }),
    {} as Record<JobStatus, Job[]>
  );
  jobs.forEach((j) => byStage[j.status]?.push(j));

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ── */}
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Research Desk</h1>
            <p className="text-xs text-muted-foreground">
              Collector → Writer → Reviewer · powered by OpenClaw + Ollama
            </p>
          </div>
          <SubmitForm onSubmitted={loadJobs} />
        </div>
      </header>

      {/* ── Stats bar ── */}
      <StatsBar jobs={jobs} />

      {/* ── Kanban board ── */}
      <main className="flex-1 max-w-screen-xl mx-auto px-4 py-5 w-full">
        <div className="board-scroll">
          {STAGE_ORDER.map((stage) => (
            <div key={stage} className="board-col">
              {/* Column header */}
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STAGE_COLORS[stage]}`}>
                  {STAGE_LABELS[stage]}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {byStage[stage].length}
                </span>
              </div>

              {/* Cards */}
              {byStage[stage].length === 0 ? (
                <div className="text-xs text-muted-foreground italic px-1">empty</div>
              ) : (
                byStage[stage].map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onClick={() => setSelected(job)}
                  />
                ))
              )}
            </div>
          ))}
        </div>
      </main>

      {/* ── Drawer ── */}
      {selected && (
        <JobDrawer
          job={selected}
          onClose={() => setSelected(null)}
          onDecision={loadJobs}
        />
      )}
    </div>
  );
}

function JobCard({ job, onClick }: { job: Job; onClick: () => void }) {
  const age = Math.round(
    (Date.now() - new Date(job.created_at).getTime()) / 60_000
  );
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border rounded-xl p-3 shadow-sm hover:shadow-md
                 hover:border-primary/40 transition-all duration-150 group"
    >
      <p className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-primary">
        {job.topic}
      </p>
      <p className="text-[11px] text-muted-foreground mt-1.5">
        {age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`}
        {job.attempts > 0 && (
          <span className="ml-2 text-amber-600">↺ retry {job.attempts}</span>
        )}
      </p>
    </button>
  );
}
