"use client";

import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import type { Note, NoteType } from "@/lib/types";

const TYPE_ORDER: NoteType[] = [
  "review",
  "decision",
  "blocker",
  "progress",
  "milestone",
  "question",
  "fyi",
];
const TYPE_LABEL: Record<NoteType, string> = {
  review: "To review",
  decision: "Decisions",
  blocker: "Blockers",
  progress: "Progress",
  milestone: "Milestones",
  question: "Questions",
  fyi: "FYI",
};
const TYPE_TONE: Record<NoteType, string> = {
  review: "text-nerf",
  decision: "text-accent",
  blocker: "text-nerf",
  progress: "text-buff",
  milestone: "text-buff",
  question: "text-accent",
  fyi: "text-muted",
};

/** Transient note types that can be checked off once handled. */
const RESOLVABLE: ReadonlySet<NoteType> = new Set(["review", "blocker", "question"]);

const WINDOWS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

export default function NotesPage() {
  const { taskMap, openTask } = useWorkspace();
  const [notes, setNotes] = useState<Note[]>([]);
  const [days, setDays] = useState(7);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let alive = true;
    fetch(
      `/api/notes?from=${encodeURIComponent(from)}${showResolved ? "&includeResolved=true" : ""}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        setNotes(data.notes ?? []);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[notes] load failed", e);
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [days, showResolved]);

  // Check off / re-open a note, then optimistically reflect it locally.
  async function toggleResolved(note: Note) {
    const resolved = !note.resolvedAt;
    setNotes((prev) =>
      prev
        .map((n) =>
          n.id === note.id
            ? { ...n, resolvedAt: resolved ? new Date().toISOString() : null }
            : n,
        )
        // If we're not showing resolved, a freshly-checked note drops out.
        .filter((n) => showResolved || !n.resolvedAt),
    );
    try {
      await fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
    } catch (e) {
      console.error("[notes] resolve failed", e);
    }
  }

  // Group by type (untyped notes fall under FYI).
  const byType = new Map<NoteType, Note[]>();
  for (const n of notes) {
    const t = (n.type ?? "fyi") as NoteType;
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(n);
  }

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Notes"
        subtitle="Team-facing callouts across your tasks — the raw material for standup."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm text-muted">Window:</span>
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={[
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  days === w.days
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-border text-muted hover:bg-surface-2 hover:text-fg",
                ].join(" ")}
              >
                {w.label}
              </button>
            ))}
            <button
              onClick={() => setShowResolved((v) => !v)}
              className={[
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                showResolved
                  ? "border-accent/30 bg-accent-soft text-accent"
                  : "border-border text-muted hover:bg-surface-2 hover:text-fg",
              ].join(" ")}
            >
              Show resolved
            </button>
            <span className="ml-auto text-[11px] text-faint">
              Tip: run the <code>standup</code> prompt in your AI for a written digest.
            </span>
          </div>

          {loading ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : notes.length === 0 ? (
            <p className="text-sm text-faint">No notes in this window.</p>
          ) : (
            <div className="space-y-5">
              {TYPE_ORDER.filter((t) => byType.get(t)?.length).map((t) => (
                <div key={t}>
                  <h3
                    className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${TYPE_TONE[t]}`}
                  >
                    {TYPE_LABEL[t]} · {byType.get(t)!.length}
                  </h3>
                  <ul className="space-y-1.5">
                    {byType.get(t)!.map((n) => {
                      const code = n.taskId
                        ? taskMap[n.taskId]?.code ?? taskMap[n.taskId]?.ref
                        : undefined;
                      const resolved = Boolean(n.resolvedAt);
                      const resolvable = RESOLVABLE.has(t);
                      return (
                        <li
                          key={n.id}
                          className={`flex items-start gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm ${resolved ? "opacity-50" : ""}`}
                        >
                          {resolvable ? (
                            <input
                              type="checkbox"
                              checked={resolved}
                              onChange={() => toggleResolved(n)}
                              className="mt-0.5 shrink-0 cursor-pointer accent-accent"
                              aria-label={resolved ? "Re-open" : "Mark done"}
                            />
                          ) : null}
                          {code ? (
                            <button
                              onClick={() => openTask(n.taskId!)}
                              className="shrink-0 font-mono text-[11px] text-muted hover:text-accent hover:underline"
                            >
                              {code}
                            </button>
                          ) : n.canvasId ? (
                            <Link
                              href={`/canvas/${n.canvasId}`}
                              className="shrink-0 text-[11px] text-muted hover:text-accent hover:underline"
                            >
                              <span className="inline-flex items-center gap-1">
                                <Pencil aria-hidden size={11} strokeWidth={1.75} />
                                canvas
                              </span>
                            </Link>
                          ) : null}
                          <span className={resolved ? "text-fg line-through" : "text-fg"}>
                            {n.note}
                          </span>
                          <span className="ml-auto shrink-0 text-[11px] text-faint">
                            {new Date(n.createdAt).toLocaleDateString()}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
