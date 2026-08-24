"use client";

/**
 * FINISH WORK — the end-of-day close-out.
 *
 * The steps here are the ones in `DAY_CLOSE` (src/lib/workflow.ts), which is also
 * what the MCP server hands an agent. Same contract, two surfaces: a day closed
 * by hand and a day closed by an agent leave the same record. If you change the
 * flow, change it there.
 *
 * Two things this view deliberately does NOT do:
 *
 *   • **Bulk-complete.** Every candidate is confirmed on its own. The close-out
 *     batches the *asking*, never the deciding — a day where you touched six
 *     tasks and finished two is the normal day.
 *   • **Hide the dates.** Anything credited to a day other than the one it was
 *     recorded on says so on the row. Attribution you can't see is attribution
 *     you can't trust, and this is the one screen that writes it.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { STATUS_LABEL } from "@/lib/statuses";
import { DAY_BOUNDARY_HOUR, workingDayOf } from "@/lib/workday";
import type { TaskStatus } from "@/lib/types";

interface SnapshotEntry {
  taskId: string;
  ref?: string;
  title: string;
  status: TaskStatus;
}

interface DayTask {
  id: string;
  code?: string;
  title: string;
  status: TaskStatus;
  summary?: string | null;
}

interface WorkDay {
  day: string;
  readyAt: string | null;
  snapshot: SnapshotEntry[] | null;
  draftedAt: string | null;
  bullets: string | null;
  summary: string | null;
  sealed: boolean;
}

interface Review {
  day: WorkDay;
  candidates: DayTask[];
  shipped: DayTask[];
  handled: DayTask[];
  worked: DayTask[];
  closedUnattributed: DayTask[];
  /** Earlier days with work on them that were never closed out. */
  openDays: string[];
  drift?: { plannedNotDone: SnapshotEntry[]; doneNotPlanned: DayTask[] };
  attribution?: string;
}

interface Project {
  id: string;
  name: string;
  boards: { id: string; name: string }[];
}

const tz = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The working day we're in right now — the same 04:00 rule the server uses, so
 *  the view can't offer to close a day the server would call tomorrow. */
const currentWorkingDay = () => workingDayOf(new Date(), tz());

/** "Fri 15 Aug" — a day the reader can place at a glance, which a bare
 *  `YYYY-MM-DD` isn't when the point is "you forgot this one". */
const formatDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** Both optional and both from the URL — see `DayPage`. A bad or stale value just
 *  falls back to the defaults it always had: the first project, and today. */
export function FinishWork({
  initialProjectId,
  initialDay,
}: {
  initialProjectId?: string;
  initialDay?: string;
} = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [day, setDay] = useState(
    // A working day is a bare date; anything else is someone editing the URL.
    initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay)
      ? initialDay
      : currentWorkingDay,
  );
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bullets, setBullets] = useState("");
  const [summary, setSummary] = useState("");
  const [pastTitle, setPastTitle] = useState("");
  const [pastBoardId, setPastBoardId] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        const list: Project[] = d.projects ?? [];
        setProjects(list);
        setProjectId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setNotice("Couldn't load projects."));
  }, []);

  const fetchReview = useCallback(async (): Promise<Review | null> => {
    if (!projectId) return null;
    const qs = new URLSearchParams({ projectId, day, tz: tz() });
    const res = await fetch(`/api/work-days?${qs}`);
    return res.ok ? ((await res.json()) as Review) : null;
  }, [projectId, day]);

  /* Switching project or day loads that day's saved draft into the boxes. A
     RELOAD after an action deliberately doesn't (`seed: false`) — otherwise
     completing a task mid-sentence would overwrite what you were typing with
     whatever was last saved. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await fetchReview();
      if (cancelled) return;
      if (!data) {
        setNotice("Couldn't load the day.");
        return;
      }
      setReview(data);
      setBullets(data.day.bullets ?? "");
      setSummary(data.day.summary ?? "");
    })();
    // A slow response for the day you just navigated away from must not land on
    // top of the one you're now looking at.
    return () => {
      cancelled = true;
    };
  }, [fetchReview]);

  const act = async (fn: () => Promise<Response>, ok: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNotice(body.error ?? "That didn't work.");
        return;
      }
      setNotice(ok);
      const data = await fetchReview();
      if (data) setReview(data);
    } finally {
      setBusy(false);
    }
  };

  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const boards = projects.find((p) => p.id === projectId)?.boards ?? [];
  const d = review?.day;
  const today = currentWorkingDay();
  const isToday = day === today;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- What day, whose board ---- */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Project
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Working day
            <input
              type="date"
              value={day}
              max={today}
              onChange={(e) => setDay(e.target.value)}
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
            />
          </label>
          <div className="flex-1" />
          <div className="flex flex-col items-end gap-1">
            <Button
              variant="outline"
              onClick={() =>
                act(
                  () => post("/api/work-days", { projectId, day }),
                  "Snapshot taken — that's the list you committed to.",
                )
              }
              disabled={busy || !projectId || !isToday}
            >
              Ready for the day
            </Button>
            {/* Explained rather than silently greyed out: a snapshot is of the
                list as it stands, so it can only be taken for the day you're in. */}
            {!isToday && (
              <span className="text-xs text-muted">
                Only for today — a snapshot is of the list as it stands.
              </span>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          A working day runs {String(DAY_BOUNDARY_HOUR).padStart(2, "0")}:00 →{" "}
          {String(DAY_BOUNDARY_HOUR).padStart(2, "0")}:00 local, so finishing
          something at 01:00 counts for the day before. Nothing here is required —
          skip it and the record is still correct.
        </p>
        {d?.sealed && (
          <p className="mt-2 text-xs text-nerf">
            This day is sealed — a later day has already been finished. Work
            closed now counts for today instead, noted as clearing older work.
          </p>
        )}
        {/* The one thing that makes the close-out find you: an unclosed day is
            otherwise invisible unless you happen to navigate to its date. */}
        {!!review?.openDays.length && (
          <div className="mt-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
            <p className="text-xs text-fg">
              {review.openDays.length === 1
                ? "This day was never closed out:"
                : `${review.openDays.length} earlier days were never closed out:`}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {review.openDays.map((od) => (
                <Button key={od} size="sm" variant="ghost" onClick={() => setDay(od)}>
                  {formatDay(od)}
                </Button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Their work never made it into a standup. Nothing will chase them —
              this is the only place they show up.
            </p>
          </div>
        )}
        {review?.attribution && (
          <p className="mt-2 text-xs text-muted">{review.attribution}</p>
        )}
        {notice && <p className="mt-2 text-xs text-accent">{notice}</p>}
      </Card>

      {/* ---- 1. Which of these finished? ---- */}
      <Card>
        <CardHeader
          title="Did any of these finish?"
          hint={
            review?.candidates.length
              ? "Touched today, still in flight. One at a time — nothing here is completed in bulk."
              : undefined
          }
        />
        <div className="px-4 pb-4">
          {review && !review.candidates.length ? (
            <p className="text-sm text-muted">
              Nothing in flight from this day.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {review?.candidates.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
                >
                  {t.code && (
                    <span className="font-mono text-xs text-muted">{t.code}</span>
                  )}
                  <span className="flex-1 text-sm text-fg">{t.title}</span>
                  <Badge>{STATUS_LABEL[t.status]}</Badge>
                  <Button
                    size="sm"
                    variant="success"
                    disabled={busy || d?.sealed}
                    onClick={() =>
                      act(
                        () =>
                          post(`/api/tasks/${t.id}/complete`, { done: true }),
                        `${t.code ?? t.title} marked done for ${day}.`,
                      )
                    }
                  >
                    Finished
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* ---- 2. What did you do that isn't here? ---- */}
      <Card>
        <CardHeader
          title="Anything that never made the board?"
          hint="A call, a conversation, an errand — it leaves no trace, so it has to be asked for."
        />
        <div className="flex flex-wrap items-end gap-2 px-4 pb-4">
          <input
            value={pastTitle}
            onChange={(e) => setPastTitle(e.target.value)}
            placeholder="Called the supplier about the delayed order"
            className="min-w-64 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
          />
          <select
            value={pastBoardId}
            onChange={(e) => setPastBoardId(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
          >
            <option value="">No board</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={busy || !pastTitle.trim()}
            onClick={() =>
              act(async () => {
                const res = await post("/api/work-days/log-past", {
                  title: pastTitle.trim(),
                  day,
                  boardId: pastBoardId || null,
                });
                if (res.ok) setPastTitle("");
                return res;
              }, `Logged against ${day}.`)
            }
          >
            Log it as done
          </Button>
          <p className="w-full text-xs text-muted">
            Becomes a real task, already done, dated {day} and filed straight into
            DONE THIS WEEK — in the record, never in a triage lane.
          </p>
        </div>
      </Card>

      {/* ---- 3. The dates ---- */}
      <Card>
        <CardHeader
          title={`What ${day} looks like`}
          hint="Credited to this working day — including anything recorded later."
        />
        <div className="flex flex-col gap-3 px-4 pb-4">
          <DayList label="Shipped" tasks={review?.shipped} />
          <DayList
            label="Handled"
            hint="reached done with no working stage — say handled, not built"
            tasks={review?.handled}
          />
          <DayList label="Still in flight" tasks={review?.worked} />
          <DayList
            label="Cleared off the board"
            hint="closed with nobody creditable — not anyone's work"
            tasks={review?.closedUnattributed}
          />
        </div>
      </Card>

      {/* ---- Drift, when a snapshot exists ---- */}
      {review?.drift && (
        <Card>
          <CardHeader
            title="Against this morning's list"
            hint={
              d?.readyAt
                ? `Snapshot taken ${new Date(d.readyAt).toLocaleTimeString()}`
                : undefined
            }
          />
          <div className="flex flex-col gap-3 px-4 pb-4">
            <div>
              <p className="mb-1 text-xs font-semibold text-muted">
                Planned, not finished
              </p>
              {review.drift.plannedNotDone.length ? (
                <ul className="flex flex-col gap-1">
                  {review.drift.plannedNotDone.map((s) => (
                    <li key={s.taskId} className="text-sm text-fg">
                      {s.ref && (
                        <span className="mr-2 font-mono text-xs text-muted">
                          {s.ref}
                        </span>
                      )}
                      {s.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">
                  Everything you planned got done.
                </p>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted">
                Done, but not planned — the day&apos;s interruptions
              </p>
              {review.drift.doneNotPlanned.length ? (
                <ul className="flex flex-col gap-1">
                  {review.drift.doneNotPlanned.map((t) => (
                    <li key={t.id} className="text-sm text-fg">
                      {t.code && (
                        <span className="mr-2 font-mono text-xs text-muted">
                          {t.code}
                        </span>
                      )}
                      {t.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing unplanned.</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ---- 4. The standup ---- */}
      <Card>
        <CardHeader
          title="The standup"
          hint={
            d?.draftedAt
              ? `Drafted ${new Date(d.draftedAt).toLocaleString()} — still editable until a later day is finished`
              : "What you'll present. An agent can write this for you via the finish_work prompt."
          }
        />
        <div className="flex flex-col gap-3 px-4 pb-4">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Write-up
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={8}
              placeholder="Progress / Blockers / Questions / To review…"
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Points that aren&apos;t about a task
            <textarea
              value={bullets}
              onChange={(e) => setBullets(e.target.value)}
              rows={3}
              placeholder="Out Thursday afternoon…"
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || !projectId || d?.sealed}
              onClick={() =>
                act(
                  () =>
                    post("/api/work-days/finish", {
                      projectId,
                      day,
                      summary: summary.trim() || null,
                      bullets: bullets.trim() || null,
                    }),
                  `${day} is drafted and ready to present.`,
                )
              }
            >
              Finish work
            </Button>
            <p className="text-xs text-muted">
              Seals itself once a later day is finished — so this stays
              correctable through the standup.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** One labelled group of the day's tasks. Renders the empty case as a sentence
 *  rather than an empty box, so a quiet day reads as quiet, not broken. */
function DayList({
  label,
  hint,
  tasks,
}: {
  label: string;
  hint?: string;
  tasks?: DayTask[];
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted">
        {label}
        {hint && <span className="ml-2 font-normal opacity-70">({hint})</span>}
      </p>
      {tasks?.length ? (
        <ul className="flex flex-col gap-1">
          {tasks.map((t) => (
            <li key={t.id} className="text-sm text-fg">
              {t.code && (
                <span className="mr-2 font-mono text-xs text-muted">
                  {t.code}
                </span>
              )}
              {t.title}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">—</p>
      )}
    </div>
  );
}
