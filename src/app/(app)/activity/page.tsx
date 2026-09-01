"use client";

/*
  ACTIVITY (TD2-211) — one chronological feed of everything everyone did.

  Two streams, interleaved server-side (`activityFeed`), because neither answers
  the question alone:

    • task entries — what CHANGED, from every surface. A human dragging a card
      and an agent moving one look the same here, which is the point.
    • call entries — what an agent ASKED. Every MCP tool invocation, including
      the reads (`list_tasks`, `board_review`, …) that change nothing and so
      leave no trace in the activity log at all.

  The default window is the last 24 hours: a log page that opens on "everything,
  ever" is a page nobody reads twice.
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Globe,
  MessageSquare,
  Send,
  Terminal,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PersonAvatar } from "@/components/PersonAvatar";
import { usePeople } from "@/components/PeopleContext";

type Source = "ui" | "api" | "mcp" | "telegram";

type Entry =
  | {
      kind: "task";
      id: string;
      at: string;
      actorId?: string;
      author?: string;
      source?: Source;
      action: string;
      message: string;
      taskId: string;
      taskTitle: string;
      taskCode?: string;
    }
  | {
      kind: "call";
      id: string;
      at: string;
      actorId?: string;
      source?: Source;
      action: string;
      name: string;
      args?: unknown;
      ok: boolean;
      error?: string;
      durationMs: number;
      resultBytes?: number;
    };

interface Stat {
  userId: string | null;
  name: string;
  calls: number;
  failures: number;
  avgMs: number;
  totalBytes: number;
}

const RANGES = [
  { key: "1h", label: "Last hour", hours: 1 },
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "30d", label: "30 days", hours: 24 * 30 },
] as const;

/** Which surface produced it — the same four the `log_source` enum defines. */
const SOURCE_META: Record<Source, { label: string; icon: typeof Globe }> = {
  ui: { label: "Web", icon: Globe },
  api: { label: "API", icon: Terminal },
  mcp: { label: "Claude", icon: Bot },
  telegram: { label: "Telegram", icon: Send },
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  const yest = new Date(today.getTime() - 86400000);
  if (same(d, yest)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export default function ActivityPage() {
  const { people, resolveById } = usePeople();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("24h");
  const [actor, setActor] = useState("");
  const [stream, setStream] = useState<"all" | "task" | "call">("all");
  const [writesOnly, setWritesOnly] = useState(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const hours = RANGES.find((r) => r.key === range)!.hours;
    const qs = new URLSearchParams({
      from: new Date(Date.now() - hours * 3600 * 1000).toISOString(),
      limit: "400",
      stats: "1",
    });
    if (actor) qs.set("actor", actor);
    if (stream !== "all") qs.set("stream", stream);
    if (writesOnly) qs.set("writesOnly", "1");
    if (text.trim()) qs.set("text", text.trim());
    const res = await fetch(`/api/activity?${qs}`);
    if (!res.ok) {
      if (res.status === 401) window.location.href = "/login";
      return;
    }
    const data = (await res.json()) as { entries: Entry[]; stats?: Stat[] };
    setEntries(data.entries);
    setStats(data.stats ?? null);
  }, [range, actor, stream, writesOnly, text]);

  // Re-run on any filter change; the text box is debounced so typing doesn't
  // fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), text ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, text]);

  /** Group into day headings — a log without them is a wall. */
  const days = useMemo(() => {
    const out: { day: string; items: Entry[] }[] = [];
    for (const e of entries ?? []) {
      const label = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last && last.day === label) last.items.push(e);
      else out.push({ day: label, items: [e] });
    }
    return out;
  }, [entries]);

  const who = (e: Entry) => {
    const p = e.actorId ? resolveById(e.actorId) : undefined;
    if (p) return p.name;
    // Pre-attribution rows carry only a display label; it's still who did it.
    return (e.kind === "task" ? e.author : undefined) ?? "Unknown";
  };

  const topStats = useMemo(
    () => (stats ?? []).slice(0, 8),
    [stats],
  );

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Activity"
        subtitle="Everything everyone did — task changes from every surface, interleaved with every MCP call an agent made, including the reads."
      />

      <div className="px-8 py-6">
        <div className="mx-auto max-w-4xl space-y-5">
          {/* ---- Filters ---- */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-border bg-surface p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    range === r.key ? "bg-accent text-white" : "text-muted hover:text-fg"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="flex rounded-lg border border-border bg-surface p-0.5">
              {(
                [
                  ["all", "Everything"],
                  ["task", "Changes"],
                  ["call", "MCP calls"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStream(key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    stream === key ? "bg-accent text-white" : "text-muted hover:text-fg"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-fg"
            >
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter…"
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-faint"
            />

            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={writesOnly}
                onChange={(e) => setWritesOnly(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Hide read-only calls
            </label>
          </div>

          {/* ---- Per-tool summary: who is hammering what ---- */}
          {topStats.length > 0 && stream !== "task" ? (
            <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                MCP calls in this window
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {topStats.map((s) => (
                  <div
                    key={`${s.userId}-${s.name}`}
                    className="flex items-center gap-1.5 text-[11px] text-muted"
                  >
                    <span className="font-mono text-fg">{s.name}</span>
                    <span>×{s.calls}</span>
                    <span className="text-faint">
                      {resolveById(s.userId ?? "")?.name ?? "—"} · {s.avgMs}ms
                      {s.totalBytes ? ` · ${bytes(s.totalBytes)}` : ""}
                    </span>
                    {s.failures ? (
                      <span className="text-red-600">{s.failures} failed</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* ---- The feed ---- */}
          {entries === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-faint">
              Nothing in this window. Widen the range, or clear the filters.
            </p>
          ) : (
            days.map((d) => (
              <div key={d.day} className="space-y-1">
                <div className="sticky top-0 z-10 bg-bg/90 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint backdrop-blur">
                  {d.day}
                </div>
                <ul className="space-y-1">
                  {d.items.map((e) => {
                    const meta = SOURCE_META[e.source ?? "ui"];
                    const Icon = meta.icon;
                    const name = who(e);
                    const expanded = open === e.id;
                    return (
                      <li
                        key={e.id}
                        className={`rounded-lg border px-3 py-2 ${
                          e.kind === "call" && !e.ok
                            ? "border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20"
                            : "border-border bg-surface"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="w-11 shrink-0 font-mono text-[11px] text-faint">
                            {time(e.at)}
                          </span>
                          <PersonAvatar name={name} size={20} />
                          <Icon size={13} className="shrink-0 text-faint" />

                          {e.kind === "task" ? (
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="truncate text-sm text-fg">
                                <span className="font-medium">{name}</span>{" "}
                                {e.message}
                              </span>
                              <Link
                                href={`/?task=${e.taskId}`}
                                className="shrink-0 truncate text-[11px] text-muted hover:text-accent"
                                title={e.taskTitle}
                              >
                                {e.taskCode ? `${e.taskCode} · ` : ""}
                                {e.taskTitle}
                              </Link>
                              {e.action === "comment" ? (
                                <MessageSquare size={12} className="shrink-0 text-faint" />
                              ) : null}
                            </div>
                          ) : (
                            <button
                              onClick={() => setOpen(expanded ? null : e.id)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <ChevronRight
                                size={12}
                                className={`shrink-0 text-faint transition-transform ${
                                  expanded ? "rotate-90" : ""
                                }`}
                              />
                              <span className="truncate text-sm text-fg">
                                <span className="font-medium">{name}</span> called{" "}
                                <span className="font-mono text-[13px]">{e.name}</span>
                              </span>
                              {e.ok ? (
                                <Check size={12} className="shrink-0 text-emerald-600" />
                              ) : (
                                <AlertTriangle size={12} className="shrink-0 text-red-600" />
                              )}
                              <span className="shrink-0 text-[11px] text-faint">
                                {e.durationMs}ms
                                {e.resultBytes ? ` · ${bytes(e.resultBytes)}` : ""}
                              </span>
                            </button>
                          )}
                        </div>

                        {/* The arguments a call was made with — the detail that
                            turns "Claude called update_task" into something you
                            can actually check. */}
                        {e.kind === "call" && expanded ? (
                          <div className="mt-2 space-y-2 border-t border-border pt-2 pl-[3.4rem]">
                            {e.error ? (
                              <p className="text-xs text-red-600">{e.error}</p>
                            ) : null}
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1.5 font-mono text-[11px] text-muted">
                              {e.args ? JSON.stringify(e.args, null, 2) : "(no arguments)"}
                            </pre>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
