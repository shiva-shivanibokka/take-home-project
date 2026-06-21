"use client";

import { useEffect, useState } from "react";
import { supabase, type Job } from "@/lib/supabase";

interface Stats {
  totalTokens: number;
  throttleCount: number;
  publishedCount: number;
  escalatedCount: number;
}

export function StatsBar({ jobs }: { jobs: Job[] }) {
  const [stats, setStats] = useState<Stats>({
    totalTokens: 0,
    throttleCount: 0,
    publishedCount: 0,
    escalatedCount: 0,
  });

  useEffect(() => {
    async function load() {
      const [handoffsRes, eventsRes] = await Promise.all([
        supabase.from("handoffs").select("tokens_used"),
        supabase.from("events").select("type"),
      ]);
      const totalTokens = (handoffsRes.data ?? []).reduce(
        (sum, h) => sum + (h.tokens_used ?? 0), 0
      );
      const throttleCount = (eventsRes.data ?? []).filter(
        (e) => e.type === "throttled"
      ).length;
      setStats({
        totalTokens,
        throttleCount,
        publishedCount: jobs.filter((j) => j.status === "published").length,
        escalatedCount: jobs.filter((j) => j.status === "escalated").length,
      });
    }
    load();
  }, [jobs]);

  const items = [
    { label: "Published", value: stats.publishedCount, color: "text-green-700" },
    { label: "Escalated", value: stats.escalatedCount, color: "text-orange-700" },
    {
      label: "Tokens used",
      value: stats.totalTokens.toLocaleString(),
      color: "text-slate-700",
    },
    { label: "Throttles", value: stats.throttleCount, color: "text-amber-700" },
  ];

  return (
    <div className="border-b bg-muted/40">
      <div className="max-w-screen-xl mx-auto px-4 py-2 flex gap-6 flex-wrap">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5">
            <span className={`text-sm font-semibold ${item.color}`}>{item.value}</span>
            <span className="text-xs text-muted-foreground">{item.label}</span>
          </div>
        ))}
        <div className="ml-auto text-xs text-muted-foreground self-center">
          Live · Ollama {process.env.NEXT_PUBLIC_OLLAMA_MODEL ?? "llama3.2:3b"}
        </div>
      </div>
    </div>
  );
}
