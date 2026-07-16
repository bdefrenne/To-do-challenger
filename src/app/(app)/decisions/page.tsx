"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import type { Decision, DecisionCategory, DecisionOutcome } from "@/lib/types";

const CATEGORIES: DecisionCategory[] = [
  "business",
  "product",
  "ux",
  "technical",
  "scope",
];
const OUTCOMES: DecisionOutcome[] = ["good", "mixed", "bad"];

const OUTCOME_TONE: Record<DecisionOutcome, string> = {
  good: "text-buff",
  mixed: "text-adjust",
  bad: "text-nerf",
};

export default function DecisionsPage() {
  const { taskMap, openTask } = useWorkspace();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [cat, setCat] = useState<DecisionCategory | "all">("all");
  const [unreviewed, setUnreviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Fetch inside the effect and update state from the .then callback (not
  // synchronously in the effect body). `tick` re-runs it after a review.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (cat !== "all") sp.set("category", cat);
    if (unreviewed) sp.set("unreviewed", "1");
    let alive = true;
    fetch(`/api/decisions?${sp}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        setDecisions(data.decisions ?? []);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[decisions] load failed", e);
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cat, unreviewed, tick]);

  const review = async (id: string, outcome: DecisionOutcome) => {
    await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    setTick((t) => t + 1);
  };

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Decisions"
        subtitle="Every choice made across your tasks — categorized, and reviewable in hindsight."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-4xl">
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <FilterChip active={cat === "all"} onClick={() => setCat("all")}>
              All
            </FilterChip>
            {CATEGORIES.map((c) => (
              <FilterChip key={c} active={cat === c} onClick={() => setCat(c)}>
                {c}
              </FilterChip>
            ))}
            <label className="ml-auto flex items-center gap-1.5 text-sm text-muted">
              <input
                type="checkbox"
                checked={unreviewed}
                onChange={(e) => setUnreviewed(e.target.checked)}
              />
              Unreviewed only
            </label>
          </div>

          {loading ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : decisions.length === 0 ? (
            <p className="text-sm text-faint">No decisions yet.</p>
          ) : (
            <ul className="space-y-2">
              {decisions.map((d) => {
                const code = taskMap[d.taskId]?.code ?? taskMap[d.taskId]?.ref;
                return (
                  <li
                    key={d.id}
                    className="rounded-lg border border-border bg-surface px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
                            {d.category}
                          </span>
                          {code ? (
                            <button
                              onClick={() => openTask(d.taskId)}
                              className="font-mono text-[11px] text-muted hover:text-accent hover:underline"
                            >
                              {code}
                            </button>
                          ) : null}
                          <span className="text-[11px] text-faint">
                            {new Date(d.createdAt).toLocaleDateString()} · {d.phase}
                          </span>
                        </div>
                        <div className="text-sm text-fg">{d.decision}</div>
                        {d.rationale ? (
                          <div className="mt-0.5 text-sm text-muted">{d.rationale}</div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {d.outcome ? (
                          <span
                            className={`text-xs font-medium ${OUTCOME_TONE[d.outcome]}`}
                          >
                            {d.outcome}
                          </span>
                        ) : (
                          OUTCOMES.map((o) => (
                            <button
                              key={o}
                              onClick={() => review(d.id, o)}
                              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
                              title={`Mark ${o}`}
                            >
                              {o}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors",
        active
          ? "border-accent/30 bg-accent-soft text-accent"
          : "border-border text-muted hover:bg-surface-2 hover:text-fg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
