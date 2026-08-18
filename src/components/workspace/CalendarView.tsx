"use client";

/*
  ====================================================================
  CALENDAR VIEW — one huge, continuously-scrollable grid of week rows,
  seven day-cells per week. Overlays two things per day:
    • Google Calendar events  — fetched read-through from /api/calendar,
      colored per calendar owner (shared + everyone's personal).
    • Tasks with a due/start date — from the workspace store, toned by
      status. Click one to open its detail modal (same as elsewhere).

  Scroll is bidirectional and infinite: sentinels at the top/bottom grow
  the rendered window (prepend compensates scroll position so the view
  doesn't jump). Events for the visible span are refetched on grow, on
  window focus, and on a light interval — so it stays in sync with Google.
  ====================================================================
*/

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorkspace } from "./WorkspaceContext";
import { STATUS_TONE, STATUS_LABEL } from "@/lib/statuses";
import type { Task } from "@/lib/types";
import { startOfWeek, addDays, ymd, fromYmd } from "@/lib/dates";

/* ---- Normalized event shape (mirrors src/lib/google/calendar.ts) ---- */
interface CalendarEvent {
  id: string;
  connectionId: string;
  source: "shared" | "personal";
  type: "standard" | "holidays";
  ownerName: string;
  color: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
  htmlLink?: string;
  editable: boolean;
}

interface Connection {
  id: string;
  scope: "shared" | "personal";
  type: "standard" | "holidays";
  ownerName: string;
  googleEmail: string;
  calendarId: string;
  color: string;
  label: string;
  /** True when this connection belongs to the logged-in user. */
  mine: boolean;
}

/* ---- Date helpers (all local-time; day keys are YYYY-MM-DD) ---- */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];


/** Which day cells an event occupies (all-day events span; end is exclusive). */
function eventDayKeys(e: CalendarEvent): string[] {
  const startKey = e.start.slice(0, 10);
  if (!e.allDay || !e.end) return [startKey];
  const endKey = e.end.slice(0, 10); // exclusive
  const keys: string[] = [];
  let cur = fromYmd(startKey);
  for (let i = 0; i < 90 && ymd(cur) < endKey; i++) {
    keys.push(ymd(cur));
    cur = addDays(cur, 1);
  }
  return keys.length ? keys : [startKey];
}

/** "14:00" from an RFC3339 datetime (best-effort, from the string). */
function timeLabel(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

const WEEKS_INITIAL_BEFORE = 3;
const WEEKS_INITIAL_AFTER = 16;
const WEEKS_GROW = 6;
const WEEKS_MAX = 520; // ~10 years of scrolling — a sane backstop

export function CalendarView() {
  const { taskMap, openTask } = useWorkspace();

  const today = useMemo(() => new Date(), []);
  const todayKey = ymd(today);

  // Rendered window: `firstMonday` .. `firstMonday + weeks`.
  const [firstMonday, setFirstMonday] = useState<Date>(() =>
    addDays(startOfWeek(new Date()), -7 * WEEKS_INITIAL_BEFORE),
  );
  const [weeks, setWeeks] = useState(WEEKS_INITIAL_BEFORE + 1 + WEEKS_INITIAL_AFTER);

  const [eventsByDay, setEventsByDay] = useState<Record<string, CalendarEvent[]>>({});
  // The contiguous day-range we've actually fetched from Google at least once.
  // Cells rendered outside this range are shown as "loading" until covered.
  const [loaded, setLoaded] = useState<{ from: string; to: string } | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showTasks, setShowTasks] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Bumped on a timer so the coverage effect retries after a failed fetch.
  const [retryTick, setRetryTick] = useState(0);

  const [composing, setComposing] = useState<string | null>(null); // day key
  const [selected, setSelected] = useState<CalendarEvent | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLDivElement>(null);
  const armedRef = useRef(false);
  const prependHeightRef = useRef<number | null>(null);
  const coverInflight = useRef(false);

  const weekList = useMemo(
    () => Array.from({ length: weeks }, (_, i) => addDays(firstMonday, i * 7)),
    [firstMonday, weeks],
  );
  const rangeFrom = ymd(firstMonday);
  const rangeTo = ymd(addDays(firstMonday, weeks * 7 - 1));

  /* ---- Tasks grouped by day (dueDate, else startDate) ---- */
  const tasksByDay = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of Object.values(taskMap)) {
      const key = t.dueDate ?? t.startDate;
      if (!key) continue;
      (map[key] ??= []).push(t);
    }
    return map;
  }, [taskMap]);

  // Read-through fetch of ONE day-range: replaces the events for exactly the
  // days in [from, to] (so deletions clear too) and keeps everything else.
  const fetchRange = useCallback(async (from: string, to: string): Promise<boolean> => {
    try {
      setSyncing(true);
      const res = await fetch(`/api/calendar/events?from=${from}&to=${to}`);
      if (res.status === 401) {
        window.location.href = "/login";
        return false;
      }
      if (!res.ok) return false;
      const { events } = (await res.json()) as { events: CalendarEvent[] };
      const grouped: Record<string, CalendarEvent[]> = {};
      for (const e of events) {
        for (const key of eventDayKeys(e)) (grouped[key] ??= []).push(e);
      }
      setEventsByDay((prev) => {
        const next: Record<string, CalendarEvent[]> = {};
        // Keep days outside the refreshed window untouched…
        for (const [k, v] of Object.entries(prev)) {
          if (k < from || k > to) next[k] = v;
        }
        // …and take the just-fetched days from the response (empty = cleared).
        for (const [k, v] of Object.entries(grouped)) {
          if (k >= from && k <= to) next[k] = v;
        }
        return next;
      });
      return true;
    } catch {
      return false;
    } finally {
      setSyncing(false);
    }
  }, []);

  // The day-range currently on screen (for cheap freshness refreshes that
  // don't depend on how far you've scrolled).
  const visibleRange = useCallback((): { from: string; to: string } | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const cRect = el.getBoundingClientRect();
    let from: string | null = null;
    let to: string | null = null;
    el.querySelectorAll<HTMLElement>("[data-week]").forEach((row) => {
      const r = row.getBoundingClientRect();
      if (r.bottom < cRect.top || r.top > cRect.bottom) return; // off-screen
      const wk = row.dataset.week!;
      const end = ymd(addDays(fromYmd(wk), 6));
      if (from === null || wk < from) from = wk;
      if (to === null || end > to) to = end;
    });
    return from !== null && to !== null ? { from, to } : null;
  }, []);

  // Load the connection roster once (for the legend + create picker).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/calendar/connections");
        if (alive && res.ok) setConnections((await res.json()).connections ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Coverage: make sure the whole RENDERED span has been fetched, pulling only
  // the newly-revealed edge(s) when you scroll — never the whole span again.
  // Serialized via a ref; re-runs as `loaded` widens and on the retry tick.
  useEffect(() => {
    if (coverInflight.current) return;
    void (async () => {
      coverInflight.current = true;
      try {
        if (!loaded) {
          if (await fetchRange(rangeFrom, rangeTo)) setLoaded({ from: rangeFrom, to: rangeTo });
          return;
        }
        if (rangeFrom < loaded.from) {
          const to = ymd(addDays(fromYmd(loaded.from), -1));
          if (await fetchRange(rangeFrom, to)) setLoaded((l) => ({ from: rangeFrom, to: l!.to }));
        }
        if (rangeTo > loaded.to) {
          const from = ymd(addDays(fromYmd(loaded.to), 1));
          if (await fetchRange(from, rangeTo)) setLoaded((l) => ({ from: l!.from, to: rangeTo }));
        }
      } finally {
        coverInflight.current = false;
      }
    })();
  }, [rangeFrom, rangeTo, loaded, retryTick, fetchRange]);

  // Freshness: refresh only the on-screen weeks (external adds/edits/deletes)
  // on a light interval + on focus. Cheap regardless of total scroll distance.
  useEffect(() => {
    const refresh = () => {
      const v = visibleRange();
      if (v) void fetchRange(v.from, v.to);
    };
    const onFocus = () => refresh();
    const iv = setInterval(() => {
      if (!document.hidden) refresh();
      setRetryTick((t) => t + 1); // also nudges coverage to retry any gap
    }, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [visibleRange, fetchRange]);

  // On first paint, jump to today's row, then arm the grow observers.
  useLayoutEffect(() => {
    todayRef.current?.scrollIntoView({ block: "start" });
    const id = window.setTimeout(() => (armedRef.current = true), 400);
    return () => window.clearTimeout(id);
  }, []);

  // Compensate scroll position after a prepend so the view doesn't jump.
  useLayoutEffect(() => {
    if (prependHeightRef.current != null && scrollRef.current) {
      scrollRef.current.scrollTop +=
        scrollRef.current.scrollHeight - prependHeightRef.current;
      prependHeightRef.current = null;
    }
  }, [firstMonday]);

  const growUp = useCallback(() => {
    if (!armedRef.current || weeks >= WEEKS_MAX) return;
    prependHeightRef.current = scrollRef.current?.scrollHeight ?? null;
    setFirstMonday((m) => addDays(m, -7 * WEEKS_GROW));
    setWeeks((w) => w + WEEKS_GROW);
  }, [weeks]);

  const growDown = useCallback(() => {
    if (!armedRef.current || weeks >= WEEKS_MAX) return;
    setWeeks((w) => w + WEEKS_GROW);
  }, [weeks]);

  // After our own create/delete, refresh just the weeks on screen.
  const refetch = useCallback(() => {
    const v = visibleRange();
    if (v) void fetchRange(v.from, v.to);
  }, [visibleRange, fetchRange]);

  const goToToday = useCallback(() => {
    todayRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  // A rendered day is "not live yet" until the coverage fetch reaches it.
  const isDayLoading = useCallback(
    (key: string) => !loaded || key < loaded.from || key > loaded.to,
    [loaded],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        connections={connections}
        hidden={hidden}
        setHidden={setHidden}
        showTasks={showTasks}
        setShowTasks={setShowTasks}
        loading={syncing}
        onToday={goToToday}
      />

      {/* Weekday header */}
      <div className="grid shrink-0 grid-cols-7 border-b border-border bg-surface-2 px-8">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-2 text-center text-[11px] font-medium uppercase tracking-wide text-faint">
            {d}
          </div>
        ))}
      </div>

      {/* Scrollable weeks */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8">
        <Sentinel onEnter={growUp} />
        {weekList.map((weekStart) => {
          // If a month begins somewhere in this week, float its name huge and
          // faint behind the row as a background watermark.
          const monthStart = Array.from({ length: 7 }, (_, i) =>
            addDays(weekStart, i),
          ).find((d) => d.getDate() === 1);
          return (
          <div key={ymd(weekStart)} data-week={ymd(weekStart)} className="relative grid grid-cols-7">
            {monthStart && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-start overflow-hidden pl-2">
                <span className="select-none whitespace-nowrap text-7xl font-bold uppercase tracking-tight text-fg/[0.05]">
                  {MONTHS_FULL[monthStart.getMonth()]}
                </span>
              </div>
            )}
            {Array.from({ length: 7 }, (_, i) => {
              const day = addDays(weekStart, i);
              const key = ymd(day);
              return (
                <DayCell
                  key={key}
                  day={day}
                  isToday={key === todayKey}
                  cellRef={key === todayKey ? todayRef : undefined}
                  loading={isDayLoading(key)}
                  events={(eventsByDay[key] ?? []).filter((e) => !hidden.has(e.connectionId))}
                  tasks={showTasks ? tasksByDay[key] ?? [] : []}
                  onOpenTask={openTask}
                  onOpenEvent={setSelected}
                  onCreate={() => setComposing(key)}
                />
              );
            })}
          </div>
          );
        })}
        <Sentinel onEnter={growDown} />
      </div>

      {composing && (
        <CreateEventDialog
          dayKey={composing}
          connections={connections}
          onClose={() => setComposing(null)}
          onCreated={() => {
            setComposing(null);
            refetch();
          }}
        />
      )}
      {selected && (
        <EventDetailDialog
          event={selected}
          onClose={() => setSelected(null)}
          onDeleted={() => {
            setSelected(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Toolbar — Today button + per-calendar legend/filter                  */
/* -------------------------------------------------------------------- */

function Toolbar({
  connections,
  hidden,
  setHidden,
  showTasks,
  setShowTasks,
  loading,
  onToday,
}: {
  connections: Connection[];
  hidden: Set<string>;
  setHidden: (s: Set<string>) => void;
  showTasks: boolean;
  setShowTasks: (v: boolean) => void;
  loading: boolean;
  onToday: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-8 py-2.5">
      <button
        onClick={onToday}
        className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Today
      </button>

      <div className="flex flex-wrap items-center gap-2">
        {connections.length === 0 ? (
          <a
            href="/settings"
            className="text-xs text-accent underline-offset-2 hover:underline"
          >
            Connect a Google calendar →
          </a>
        ) : (
          connections.map((c) => {
            const off = hidden.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                className={[
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  off
                    ? "border-border text-faint"
                    : "border-border-strong text-fg hover:bg-surface-2",
                ].join(" ")}
                title={`${c.googleEmail} · ${c.calendarId}`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: off ? "transparent" : c.color, border: `1px solid ${c.color}` }}
                />
                {c.label}
              </button>
            );
          })
        )}
        <button
          onClick={() => setShowTasks(!showTasks)}
          className={[
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
            showTasks
              ? "border-border-strong text-fg hover:bg-surface-2"
              : "border-border text-faint",
          ].join(" ")}
        >
          <span className={`h-2.5 w-2.5 rounded-[3px] ${showTasks ? "bg-accent" : "border border-accent"}`} />
          Tasks
        </button>
      </div>

      {loading && <span className="ml-auto text-[11px] text-faint">Syncing…</span>}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* One day cell                                                         */
/* -------------------------------------------------------------------- */

function DayCell({
  day,
  isToday,
  cellRef,
  loading,
  events,
  tasks,
  onOpenTask,
  onOpenEvent,
  onCreate,
}: {
  day: Date;
  isToday: boolean;
  cellRef?: React.Ref<HTMLDivElement>;
  loading: boolean;
  events: CalendarEvent[];
  tasks: Task[];
  onOpenTask: (id: string) => void;
  onOpenEvent: (e: CalendarEvent) => void;
  onCreate: () => void;
}) {
  const isFirst = day.getDate() === 1;
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  return (
    <div
      ref={cellRef}
      onDoubleClick={(e) => {
        // Ignore double-clicks that land on an existing task/event button.
        if ((e.target as HTMLElement).closest("button")) return;
        onCreate();
      }}
      className={[
        "group relative min-h-28 cursor-pointer border-b border-r border-border p-1.5",
        weekend ? "bg-surface-2/40" : "bg-surface",
      ].join(" ")}
    >
      <div className="mb-1 flex items-center justify-between">
        <span
          className={[
            "grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs",
            isToday ? "bg-accent font-semibold text-white" : "text-muted",
          ].join(" ")}
        >
          {isFirst ? `${MONTHS[day.getMonth()]} ${day.getDate()}` : day.getDate()}
        </span>
        <button
          onClick={onCreate}
          title="Add event"
          className="text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          +
        </button>
      </div>

      {loading && (
        <span
          className="pointer-events-none absolute right-1.5 top-1.5 h-3 w-3 animate-spin rounded-full border border-faint border-t-transparent"
          title="Syncing this day with Google…"
          aria-label="Loading"
        />
      )}

      <div className="space-y-0.5">
        {events.map((e) => (
          <button
            key={`${e.connectionId}:${e.id}`}
            onClick={() => onOpenEvent(e)}
            className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-fg transition-opacity hover:opacity-80"
            style={{ backgroundColor: `${e.color}22` }}
            title={`${e.title} — ${e.ownerName}`}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
            {!e.allDay && <span className="shrink-0 text-faint">{timeLabel(e.start)}</span>}
            <span className="truncate">{e.title}</span>
          </button>
        ))}
        {tasks.map((t) => {
          const tone = STATUS_TONE[t.status];
          return (
            <button
              key={t.id}
              onClick={() => onOpenTask(t.id)}
              className={`flex w-full items-center gap-1 truncate rounded border px-1 py-0.5 text-left text-[11px] ${tone.bg} ${tone.text} ${tone.border}`}
              title={`${t.title} · ${STATUS_LABEL[t.status]}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
              <span className={`truncate ${t.status === "done" ? "opacity-70" : ""}`}>
                {t.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Infinite-scroll sentinel                                             */
/* -------------------------------------------------------------------- */

function Sentinel({ onEnter }: { onEnter: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onEnter();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onEnter]);
  return <div ref={ref} className="h-1" />;
}

/* -------------------------------------------------------------------- */
/* Create-event dialog                                                  */
/* -------------------------------------------------------------------- */

function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CreateEventDialog({
  dayKey,
  connections,
  onClose,
  onCreated,
}: {
  dayKey: string;
  connections: Connection[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // Holidays calendars are read-only from the view — never offered as a target.
  const targets = connections.filter((c) => c.type !== "holidays");
  // Default to the user's OWN personal calendar, then the shared one, then any.
  const preferred =
    targets.find((c) => c.mine && c.scope === "personal") ??
    targets.find((c) => c.scope === "shared") ??
    targets[0];
  const [title, setTitle] = useState("");
  const [calendar, setCalendar] = useState<string>(preferred?.id ?? "shared");
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nice = fromYmd(dayKey).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    const payload = allDay
      ? { calendar, title: title.trim(), start: dayKey, allDay: true }
      : {
          calendar,
          title: title.trim(),
          start: `${dayKey}T${startTime}:00`,
          end: `${dayKey}T${endTime}:00`,
          allDay: false,
        };
    try {
      const res = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `Failed (${res.status})`);
        return;
      }
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose}>
      <h2 className="text-sm font-semibold">New event</h2>
      <p className="mb-4 text-xs text-muted">{nice}</p>

      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Event title"
        className="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
      />

      <label className="mb-1 block text-xs font-medium text-muted">Calendar</label>
      <select
        value={calendar}
        onChange={(e) => setCalendar(e.target.value)}
        className="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
      >
        {targets.length === 0 && <option value="shared">Shared (not connected yet)</option>}
        {targets.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.googleEmail}
            {c.mine ? " (you)" : ""}
          </option>
        ))}
      </select>

      <label className="mb-3 flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        All day
      </label>

      {!allDay && (
        <div className="mb-3 flex items-center gap-2">
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
          <span className="text-faint">→</span>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
      )}

      {err && <p className="mb-3 text-xs text-nerf">{err}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !title.trim() || targets.length === 0}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add event"}
        </button>
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------------- */
/* Event detail dialog                                                  */
/* -------------------------------------------------------------------- */

function EventDetailDialog({
  event,
  onClose,
  onDeleted,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Holidays calendars are read-only from the view — no deleting here.
  const readOnly = event.type === "holidays";

  const when = event.allDay
    ? fromYmd(event.start.slice(0, 10)).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : `${fromYmd(event.start.slice(0, 10)).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })} · ${timeLabel(event.start)}–${timeLabel(event.end)}`;

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(event.id)}?calendar=${encodeURIComponent(event.connectionId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `Failed (${res.status})`);
        return;
      }
      onDeleted();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose}>
      <div className="mb-1 flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: event.color }} />
        <span className="text-xs text-muted">{event.ownerName}</span>
      </div>
      <h2 className="text-base font-semibold text-fg">{event.title}</h2>
      <p className="mt-1 text-sm text-muted">{when}</p>
      {event.location && <p className="mt-1 text-sm text-muted">📍 {event.location}</p>}
      {event.description && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-fg">{event.description}</p>
      )}

      {err && <p className="mt-3 text-xs text-nerf">{err}</p>}

      <div className="mt-5 flex items-center justify-between">
        {event.htmlLink ? (
          <a
            href={event.htmlLink}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-accent underline-offset-2 hover:underline"
          >
            Open in Google Calendar ↗
          </a>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {!readOnly && (
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm text-nerf transition-colors hover:bg-nerf-soft disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2"
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
