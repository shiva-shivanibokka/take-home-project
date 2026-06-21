"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export function SubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [topic, setTopic]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);

    const { error: err } = await supabase
      .from("jobs")
      .insert({ topic: topic.trim(), status: "queued" });

    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      setTopic("");
      onSubmitted();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-center">
      <input
        type="text"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Research topic or question…"
        className="border rounded-lg px-3 py-1.5 text-sm w-64 focus:outline-none
                   focus:ring-2 focus:ring-primary/50"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={loading || !topic.trim()}
        className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium
                   disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {loading ? "Submitting…" : "Submit"}
      </button>
      {error && (
        <p className="text-xs text-red-600 max-w-xs">{error}</p>
      )}
    </form>
  );
}
