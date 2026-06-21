"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { X, CheckCircle, XCircle, Clock, AlertTriangle, Zap } from "lucide-react";
import {
  supabase, STAGE_LABELS, STAGE_COLORS,
  type Job, type Handoff, type Event, type Review,
} from "@/lib/supabase";

interface Props {
  job: Job;
  onClose: () => void;
  onDecision: () => void;
}

export function JobDrawer({ job, onClose, onDecision }: Props) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [events,   setEvents]   = useState<Event[]>([]);
  const [reviews,  setReviews]  = useState<Review[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [notes,    setNotes]    = useState("");
  const [deciding, setDeciding] = useState(false);
  const [activeTab, setActiveTab] = useState<"brief" | "handoffs" | "timeline">("brief");

  useEffect(() => {
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

    // Realtime updates for events (retries etc appear live in the drawer)
    const ch = supabase
      .channel(`drawer-${job.id}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "events", filter: `job_id=eq.${job.id}` },
        (p) => setEvents((prev) => [...prev, p.new as Event])
      )
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "handoffs", filter: `job_id=eq.${job.id}` },
        (p) => setHandoffs((prev) => [...prev, p.new as Handoff])
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [job.id]);

  // ── Human review action ───────────────────────────────────────────────────
  const decide = async (decision: "approve" | "reject") => {
    setDeciding(true);
    await supabase.from("reviews").insert({
      job_id: job.id,
      decision,
      notes: notes || null,
      reviewer: reviewer || "anonymous",
    });
    setDeciding(false);
    onDecision();
    onClose();
  };

  const writerHandoff = handoffs.find((h) => h.from_stage === "writing");
  const reviewerHandoff = handoffs.find((h) => h.from_stage === "review");
  const collectorHandoff = handoffs.find((h) => h.from_stage === "collecting");

  const totalTokens = handoffs.reduce((s, h) => s + (h.tokens_used ?? 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-white shadow-2xl flex flex-col animate-slide-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Drawer header ── */}
        <div className="border-b px-5 py-4 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground mb-0.5">Research Job</p>
            <h2 className="font-semibold text-base leading-snug">{job.topic}</h2>
            <span className={`inline-block text-xs px-2 py-0.5 rounded-full mt-1.5 ${STAGE_COLORS[job.status]}`}>
              {STAGE_LABELS[job.status]}
            </span>
            {totalTokens > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground ml-2">
                <Zap size={11} /> {totalTokens.toLocaleString()} tokens
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50">
            <X size={18} />
          </button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b text-sm">
          {(["brief", "handoffs", "timeline"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-4 py-2 capitalize font-medium border-b-2 transition-colors ${
                activeTab === t
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* BRIEF tab */}
          {activeTab === "brief" && (
            <div>
              {writerHandoff ? (
                <>
                  {/* Reviewer confidence badge */}
                  {reviewerHandoff && (
                    <div className={`flex items-center gap-2 p-3 rounded-lg mb-4 text-sm ${
                      (reviewerHandoff.confidence ?? 0) >= 0.7
                        ? "bg-green-50 border border-green-200"
                        : "bg-orange-50 border border-orange-200"
                    }`}>
                      {(reviewerHandoff.confidence ?? 0) >= 0.7
                        ? <CheckCircle size={15} className="text-green-600 shrink-0" />
                        : <AlertTriangle size={15} className="text-orange-600 shrink-0" />}
                      <span>
                        Confidence: <strong>{((reviewerHandoff.confidence ?? 0) * 100).toFixed(0)}%</strong>
                        {" · "}
                        {(reviewerHandoff.artifact as any).verdict === "escalate"
                          ? "Escalated for human review"
                          : "Passed review"}
                      </span>
                    </div>
                  )}

                  {/* Reviewer reasons */}
                  {reviewerHandoff && ((reviewerHandoff.artifact as any).reasons ?? []).length > 0 && (
                    <div className="bg-muted/50 rounded-lg p-3 mb-4 text-xs space-y-1">
                      <p className="font-semibold text-muted-foreground mb-1">Reviewer notes:</p>
                      {((reviewerHandoff.artifact as any).reasons as string[]).map((r, i) => (
                        <p key={i} className="text-muted-foreground">• {r}</p>
                      ))}
                    </div>
                  )}

                  {/* The brief */}
                  <div className="brief-content prose-sm">
                    <ReactMarkdown>
                      {(writerHandoff.artifact as any).brief_markdown as string}
                    </ReactMarkdown>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  Brief not yet written — job is in stage "{STAGE_LABELS[job.status]}".
                </p>
              )}

              {/* Collector sources */}
              {collectorHandoff && (
                <div className="mt-6">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Sources ({(collectorHandoff.artifact as any).count})
                  </h3>
                  <ul className="space-y-1.5">
                    {((collectorHandoff.artifact as any).sources as any[]).map((s, i) => (
                      <li key={i} className="text-xs">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline font-medium"
                        >
                          {s.title || s.url}
                        </a>
                        {s.snippet && (
                          <p className="text-muted-foreground line-clamp-1 mt-0.5">{s.snippet}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* HANDOFFS tab — the graded artifact */}
          {activeTab === "handoffs" && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Each row is the JSON handoff record written by the agent when it
                completes its stage. This is the auditable contract between agents.
              </p>
              {handoffs.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">No handoffs yet.</p>
              ) : (
                handoffs.map((h) => (
                  <div key={h.id} className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/50 px-3 py-2 flex items-center gap-2 text-xs font-medium">
                      <span className="text-muted-foreground">{h.from_stage}</span>
                      <span>→</span>
                      <span>{h.to_stage}</span>
                      <span className="ml-auto text-muted-foreground">agent: {h.agent_id}</span>
                      {h.tokens_used && (
                        <span className="text-muted-foreground">{h.tokens_used} tokens</span>
                      )}
                      {h.confidence != null && (
                        <span className={h.confidence >= 0.7 ? "text-green-700" : "text-orange-700"}>
                          {(h.confidence * 100).toFixed(0)}% conf
                        </span>
                      )}
                    </div>
                    <pre className="text-[11px] p-3 overflow-x-auto bg-slate-50 max-h-64">
                      {JSON.stringify(h.artifact, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TIMELINE tab — observability */}
          {activeTab === "timeline" && (
            <div className="space-y-2">
              {events.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">No events yet.</p>
              ) : (
                events.map((ev) => (
                  <div key={ev.id} className="flex gap-3 text-xs">
                    <EventIcon type={ev.type} />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium capitalize">{ev.type}</span>
                      {ev.stage && <span className="text-muted-foreground"> · {ev.stage}</span>}
                      {Object.keys(ev.detail).length > 0 && (
                        <pre className="text-[10px] text-muted-foreground mt-0.5 overflow-x-auto">
                          {JSON.stringify(ev.detail)}
                        </pre>
                      )}
                    </div>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(ev.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* ── Human review panel (escalated only) ── */}
        {job.status === "escalated" && reviews.length === 0 && (
          <div className="border-t p-5 bg-orange-50">
            <p className="text-sm font-semibold text-orange-900 mb-3 flex items-center gap-1.5">
              <AlertTriangle size={15} /> Human review required
            </p>
            <p className="text-xs text-orange-800 mb-3">
              The Reviewer agent escalated this brief (confidence below threshold or a check failed).
              Read the brief above and decide.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                placeholder="Your name (optional)"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                className="border rounded px-2 py-1.5 text-xs flex-1 bg-white"
              />
            </div>
            <textarea
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-xs bg-white mb-3 h-16 resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => decide("approve")}
                disabled={deciding}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg
                           bg-green-600 text-white text-sm font-medium hover:bg-green-700
                           disabled:opacity-50 transition-colors"
              >
                <CheckCircle size={15} /> Approve & Publish
              </button>
              <button
                onClick={() => decide("reject")}
                disabled={deciding}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg
                           bg-red-600 text-white text-sm font-medium hover:bg-red-700
                           disabled:opacity-50 transition-colors"
              >
                <XCircle size={15} /> Reject
              </button>
            </div>
          </div>
        )}

        {/* Show past decisions */}
        {reviews.length > 0 && (
          <div className="border-t p-4 bg-muted/30">
            {reviews.map((r) => (
              <div key={r.id} className="text-xs flex items-center gap-2">
                {r.decision === "approve"
                  ? <CheckCircle size={13} className="text-green-600" />
                  : <XCircle size={13} className="text-red-600" />}
                <span className="font-medium capitalize">{r.decision}d</span>
                {r.reviewer && <span className="text-muted-foreground">by {r.reviewer}</span>}
                {r.notes && <span className="text-muted-foreground">— {r.notes}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventIcon({ type }: { type: string }) {
  const cls = "shrink-0 mt-0.5";
  switch (type) {
    case "started":    return <Clock size={13} className={`${cls} text-blue-500`} />;
    case "retry":      return <span className={`${cls} text-amber-600 text-sm`}>↺</span>;
    case "throttled":  return <Zap size={13} className={`${cls} text-amber-500`} />;
    case "failed":     return <XCircle size={13} className={`${cls} text-red-500`} />;
    case "escalated":  return <AlertTriangle size={13} className={`${cls} text-orange-500`} />;
    case "published":  return <CheckCircle size={13} className={`${cls} text-green-500`} />;
    case "human_decision": return <span className={`${cls} text-blue-700 text-sm`}>👤</span>;
    default:           return <span className={`${cls} text-muted-foreground`}>·</span>;
  }
}
