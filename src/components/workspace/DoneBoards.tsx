"use client";

import {
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board, Project, Task } from "@/lib/types";
import { allBoards } from "@/lib/boards";
import { addDays, fromYmd, startOfWeek, ymd } from "@/lib/dates";
import { workingDayOf } from "@/lib/workday";
import { Avatar } from "@/components/ui/Badge";
import { Markdown } from "@/components/ui/Markdown";
import { usePeople, type Person } from "@/components/PeopleContext";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "./WorkspaceContext";
import { SeparatorHeader } from "./SeparatorHeader";
import { TaskCard } from "./TaskCard";

/* ---- The shape /api/tasks/done returns (see `listCompletions`) ---- */

interface Completion {
  task: Task & { parentId?: string | null };
  at: string;
  /** YYYY-MM-DD in the requested tz — bucketed server-side. */
  day: string;
  creditedTo: string | null;
  closedBy: string | null;
}

/** That one person wrote a standup for one day, and roughly what it said (see
 *  `listDayWriteUps`). No prose: the full text is a click away, on its own route.
 *  Four weeks × a whole team of authored text is exactly what PLAT-403 removed
 *  from collection reads. */
interface DayWriteUp {
  userId: string;
  day: string;
  draftedAt: string;
  /** One plain-text line — pre-cut server-side by `previewOf`. */
  preview: string;
  hasMore: boolean;
}

/** The full write-up, from `/api/work-days/write-up`. */
interface FullWriteUp {
  summary: string | null;
  bullets: string | null;
  /** False while a later day hasn't been drafted — the write-up is still a
   *  correctable draft, which is worth saying out loud. */
  sealed: boolean;
}

interface CompletionsPage {
  from: string;
  to: string;
  tz: string;
  entries: Completion[];
  truncated?: boolean;
  attribution?: string;
  writeUps?: DayWriteUp[];
}

/** How many weeks one load covers — the first load and every "load more" press
 *  alike, so the range grows in even steps you can reason about. */
const CHUNK_WEEKS = 4;

/** How many days are expanded by default. Today and yesterday: the window you
 *  actually re-read. Everything older is one click away. */
const OPEN_DAYS = 2;

/** The key for one week's collapse state — its Monday. */
const weekKey = (day: string) => ymd(startOfWeek(fromYmd(day)));

/** Column head for the tasks nobody can be credited for. `creditedTo` is null
 *  exactly when a task reached done with no assignees (see `creditFor`), so this
 *  is a real category, not a loading state. The leading space sorts it apart
 *  from any real user id. */
const NO_ASSIGNEE = " none";

/**
 * How a DAY is laid out. Both show the same completions on the same two axes —
 * who finished it, and which board it belongs to — and differ only in which axis
 * is the column and which is the separator inside it.
 *
 * `person` (the default) reads as "what did each of us get done": one column per
 * person, and inside it a small board separator per board they touched. It stays
 * legible on a day when one person closed everything, which is the common case —
 * the `board` layout spends a full-width band on each board to show a single
 * column under it.
 */
type DayLayout = "person" | "board";

/**
 * A project's **Done** view: the record of the team's WORK DAYS, read top-down as
 * collapsible WEEKS, and inside each, collapsible DAYS.
 *
 * A work day, not a completion, is what a row here amounts to — one person, one
 * project, one day, which is the key `work_days` is unique on. Two things follow:
 * a day shows up because someone finished something in it OR because someone
 * wrote a standup for it (a write-up must not vanish along with the cards it
 * describes), and a person column carries that standup as its head.
 *
 * Within a day the unit is a completion, not a task: a task credited to two
 * people shows in both their columns, and one finished, reopened, and finished
 * again shows on both days. Which is why this reads `/api/tasks/done` (the
 * status-event log) rather than filtering the workspace store by
 * `status === "done"` — the store holds only current state, so it could neither
 * date a completion nor say whose it was, and past weeks would rewrite themselves
 * on every reopen.
 *
 * Cards deliberately do NOT get the green done wash they carry everywhere else:
 * here everything is done, so green distinguishes nothing, and the importance
 * colors it would cover are the only signal left worth having.
 */
export function DoneBoards({ project }: { project: Project }) {
  const { openTask, taskMap } = useWorkspace();
  const { people, resolveById, me } = usePeople();

  const [chunks, setChunks] = useState(1);
  const [page, setPage] = useState<CompletionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dayLayout, setDayLayout] = useViewMode<DayLayout>(
    "done-day-layout",
    "person",
  );

  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  /* "Today" is the WORKING day, not the calendar one — the same rule the server
     files each completion under (`workingDayOf`). Read at 01:00 that's still
     yesterday's date, and using local midnight here instead would leave the day
     you're actually working collapsed and ask for a range ending a day early. */
  const todayDay = useMemo(() => workingDayOf(new Date(), tz), [tz]);
  const today = useMemo(() => fromYmd(todayDay), [todayDay]);

  /* How many weeks are loaded. Whole weeks back from the current one, so a week is
     never half-loaded (which would show a misleading count in its header). */
  const weeks = chunks * CHUNK_WEEKS;

  /**
   * Fetch a chunk and MERGE it, rather than refetching the widened range and
   * replacing what's held.
   *
   * Each press used to re-download weeks 1..4N from scratch, so cumulative egress
   * grew quadratically in presses — for a payload that is mostly immutable
   * history. Chunks tile exactly (`dateWindow` is half-open, so `from`/`to` seams
   * neither double-count nor skip a day), which is what makes a merge sound with
   * no de-duplication. Same shape as `CalendarView`'s ranged load.
   */
  const load = useCallback(
    async (from: string, to: string, mode: "replace" | "prepend") => {
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({
        projectId: project.id,
        from,
        to,
        // Bucket days in the reader's own zone: "what did we finish Monday" means
        // Monday where they are.
        tz,
      });
      try {
        const res = await fetch(`/api/tasks/done?${q}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const chunk = (await res.json()) as CompletionsPage;
        setPage((held) =>
          mode === "replace" || !held
            ? chunk
            : {
                // The OLDER chunk arrives; entries stay newest-first, so it goes
                // on the end. `from` widens, everything else describes the newest
                // chunk and still holds for the union.
                ...held,
                from: chunk.from,
                entries: [...held.entries, ...chunk.entries],
                writeUps: [...(held.writeUps ?? []), ...(chunk.writeUps ?? [])],
                ...(chunk.truncated ? { truncated: true } : {}),
                ...(chunk.attribution ? { attribution: chunk.attribution } : {}),
              },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [project.id, tz],
  );

  /* One press = one chunk. `loadedFrom` is the oldest day already held, so the
     new request covers only `[newStart, loadedFrom)` — and `to` is exclusive of
     that boundary day by one, since `dateWindow` includes both edges. */
  const loadedFrom = useRef<string | null>(null);
  const loadMore = useCallback(() => {
    const held = loadedFrom.current;
    if (!held) return;
    const newStart = ymd(addDays(fromYmd(held), -7 * CHUNK_WEEKS));
    loadedFrom.current = newStart;
    setChunks((n) => n + 1);
    void load(newStart, ymd(addDays(fromYmd(held), -1)), "prepend");
  }, [load]);

  /* The FIRST chunk only — later ones are appended by `loadMore`, so this must not
     depend on the widening range or every press would refetch the lot again. */
  useEffect(() => {
    const from = ymd(addDays(startOfWeek(today), -7 * (CHUNK_WEEKS - 1)));
    loadedFrom.current = from;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState runs after the await, not synchronously
    void load(from, todayDay, "replace");
  }, [load, today, todayDay]);

  /* ---- collapse state ----
     Persisted as a comma-joined set of keys whose state is FLIPPED from the
     default, not a set of open keys — so "the current week is open" and "the
     last two days are open" keep meaning that as time moves on, instead of
     pinning last week's choices to whatever was current when they were made. */
  const [flipped, setFlipped] = useViewMode<string>(
    `done-collapsed:${project.id}`,
    "",
  );
  const flippedSet = useMemo(
    () => new Set(flipped.split(",").filter(Boolean)),
    [flipped],
  );
  const toggle = (key: string) => {
    const next = new Set(flippedSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFlipped([...next].join(","));
  };
  const isOpen = (key: string, openByDefault: boolean) =>
    flippedSet.has(key) ? !openByDefault : openByDefault;

  /* ---- bucket the log: week → day → entries ---- */

  const byWeek = useMemo(() => {
    const m = new Map<string, Map<string, Completion[]>>();
    const bucket = (day: string) => {
      const wk = weekKey(day);
      let days = m.get(wk);
      if (!days) m.set(wk, (days = new Map()));
      let list = days.get(day);
      if (!list) days.set(day, (list = []));
      return list;
    };
    for (const e of page?.entries ?? []) bucket(e.day).push(e);
    /* A day someone wrote a standup for but closed nothing in is still a day
       worth reading — often the most worth reading. Seed it so it gets a row
       with the prose and no cards, rather than vanishing along with it. */
    for (const w of page?.writeUps ?? []) bucket(w.day);
    return m;
  }, [page]);

  /** The day's write-ups, keyed by person. One map for the whole page; the
   *  columns look themselves up. */
  const writeUpAt = useMemo(() => {
    const m = new Map<string, DayWriteUp>();
    for (const w of page?.writeUps ?? []) m.set(`${w.userId} ${w.day}`, w);
    return m;
  }, [page]);

  /** Who wrote something on a given day, in no particular order — the extra
   *  columns a day needs beyond the people it credits work to. */
  const authorsOn = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of page?.writeUps ?? []) {
      const list = m.get(w.day);
      if (list) list.push(w.userId);
      else m.set(w.day, [w.userId]);
    }
    return m;
  }, [page]);

  /* Every week in the loaded range, newest first — including EMPTY ones. A week
     you finished nothing in is a fact worth seeing; skipping it would also make
     "load 4 more weeks" look broken whenever the older range is empty. */
  const weekStarts = useMemo(() => {
    const first = startOfWeek(today);
    return Array.from({ length: weeks }, (_, i) => ymd(addDays(first, -7 * i)));
  }, [today, weeks]);

  const currentWeek = ymd(startOfWeek(today));
  /* The oldest day left expanded — working days, so this holds in the small
     hours too. */
  const openFrom = ymd(addDays(today, -(OPEN_DAYS - 1)));

  /** Your own id on a day you never wrote up, else null — the one column allowed
   *  to offer the close-out. Restricted to the days still expanded by default:
   *  older unwritten days are water under the bridge, and `finishWork` refuses a
   *  sealed day anyway, so offering it there would be a dead link. */
  const promptFor = useCallback(
    (day: string) =>
      me && day >= openFrom && !writeUpAt.has(`${me.id} ${day}`) ? me.id : null,
    [me, openFrom, writeUpAt],
  );

  /* Both lookups below read hidden boards too (TD2-213). The Done view is
     HISTORY: work finished on a board that has since been put away still
     happened, and the day it was finished must still name the board it was on.
     Hiding a board takes it off what's being WORKED, not out of the record. */
  /** Board order within the project — the order the Boards view and the sidebar
   *  already use, so the same work sits in the same place on every screen. */
  const boardIndex = useMemo(() => {
    const m = new Map<string, number>();
    allBoards(project).forEach((b, i) => m.set(b.id, i));
    return m;
  }, [project]);

  const boardOf = useCallback(
    (id?: string | null) => allBoards(project).find((b) => b.id === id),
    [project],
  );

  /** Roster order (name-sorted), so a person keeps the same column position from
   *  one day to the next. */
  const personIndex = useMemo(() => {
    const m = new Map<string, number>();
    people.forEach((p, i) => m.set(p.id, i));
    return m;
  }, [people]);

  /** The day's people and boards, each in its stable order. Computed once per
   *  day and shared by both layouts — which is what keeps a person in the same
   *  column position whichever way you're reading.
   *
   *  `alsoPeople` are people who belong in the day whether or not they're
   *  credited with anything: someone who wrote a standup and closed nothing. */
  const axesOf = useCallback(
    (entries: Completion[], alsoPeople: string[] = []) => {
      const personIds = [
        ...new Set([
          ...entries.map((e) => e.creditedTo ?? NO_ASSIGNEE),
          ...alsoPeople,
        ]),
      ].sort((a, b) => {
        if (a === NO_ASSIGNEE) return 1;
        if (b === NO_ASSIGNEE) return -1;
        return (personIndex.get(a) ?? 999) - (personIndex.get(b) ?? 999);
      });
      const boardIds = [
        ...new Set(entries.map((e) => e.task.boardId ?? "")),
      ].sort((a, b) => (boardIndex.get(a) ?? 999) - (boardIndex.get(b) ?? 999));
      return { personIds, boardIds };
    },
    [boardIndex, personIndex],
  );

  const cardFor = useCallback(
    (e: Completion) => (
      <DoneCard
        key={e.task.id}
        entry={e}
        inStore={!!taskMap[e.task.id]}
        onOpen={() => openTask(e.task.id)}
      />
    ),
    [openTask, taskMap],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <ViewToggle
          value={dayLayout}
          onChange={setDayLayout}
          options={[
            { value: "person", label: "By person" },
            { value: "board", label: "By board" },
          ]}
        />
      </div>

      {error ? (
        <p className="text-sm text-danger">Couldn’t load the Done log: {error}</p>
      ) : null}

      {weekStarts.map((wk) => {
        const days = byWeek.get(wk);
        const all = days ? [...days.values()].flat() : [];
        const open = isOpen(`w:${wk}`, wk === currentWeek);
        const end = addDays(fromYmd(wk), 6);
        return (
          <section key={wk} className="space-y-2">
            <SeparatorHeader
              title={`${fromYmd(wk).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              })} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
              count={distinctTasks(all)}
              bar="bg-linear-to-r from-slate-700 via-slate-600 to-slate-400"
              collapsed={!open}
              onToggle={() => toggle(`w:${wk}`)}
            />

            {!open ? null : !days?.size ? (
              <p className="px-4 py-2 text-sm text-faint">
                {loading ? "Loading…" : "Nothing finished this week."}
              </p>
            ) : (
              /* Days newest first. Only days with completions are drawn — seven
                 empty rows per week would bury the ones that matter. */
              [...days!.keys()]
                .sort((a, b) => b.localeCompare(a))
                .map((day) => {
                  const entries = days!.get(day)!;
                  const dayOpen = isOpen(`d:${day}`, day >= openFrom);
                  /* Standup authors join the person axis only in the layout that
                     shows their prose — a blank extra column in `board` would be
                     pure padding. */
                  const authors = authorsOn.get(day) ?? [];
                  const standups = authors.length;
                  const { personIds, boardIds } = axesOf(
                    entries,
                    dayLayout === "person" ? authors : [],
                  );
                  return (
                    <div key={day} className="space-y-2 pl-4">
                      <SeparatorHeader
                        size="sm"
                        title={fromYmd(day).toLocaleDateString("en-GB", {
                          weekday: "long",
                          day: "numeric",
                          month: "long",
                        })}
                        count={distinctTasks(entries)}
                        bar="bg-linear-to-r from-indigo-700 via-blue-600 to-sky-400"
                        collapsed={!dayOpen}
                        onToggle={() => toggle(`d:${day}`)}
                        /* Standups live on the person columns, so `board` can't
                           show them — say they exist rather than letting a layout
                           toggle silently drop content. Plain text, not a link:
                           the header is itself a button. */
                        right={
                          dayLayout === "board" && standups > 0 ? (
                            <span className="text-[11px] font-medium text-white/70">
                              {standups === 1
                                ? "1 standup"
                                : `${standups} standups`}{" "}
                              — see By person
                            </span>
                          ) : undefined
                        }
                      />

                      {!dayOpen ? null : dayLayout === "person" ? (
                        <DayByPerson
                          entries={entries}
                          personIds={personIds}
                          boardIds={boardIds}
                          boardOf={boardOf}
                          resolveById={resolveById}
                          cardFor={cardFor}
                          projectId={project.id}
                          day={day}
                          writeUpFor={(uid) => writeUpAt.get(`${uid} ${day}`)}
                          promptWriteUp={promptFor(day)}
                        />
                      ) : (
                        <DayByBoard
                          entries={entries}
                          personIds={personIds}
                          boardIds={boardIds}
                          boardOf={boardOf}
                          resolveById={resolveById}
                          cardFor={cardFor}
                          projectId={project.id}
                          day={day}
                        />
                      )}
                    </div>
                  );
                })
            )}
          </section>
        );
      })}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          disabled={loading}
          onClick={loadMore}
          className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        >
          {loading ? "Loading…" : `Load ${CHUNK_WEEKS} more weeks`}
        </button>
        {/* The event log starts partway through this project's life, so an empty
            older week means "not recorded", not "nothing shipped". Say which. */}
        {page?.attribution ? (
          <span className="text-xs text-faint">
            Completions before{" "}
            {new Date(page.attribution.slice("unavailable-before-".length))
              .toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}{" "}
            weren’t recorded — earlier weeks read empty rather than complete.
          </span>
        ) : null}
        {page?.truncated ? (
          <span className="text-xs text-danger">
            Too many completions in this range to show them all.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** How many distinct TASKS a set of completions covers — not `list.length`,
 *  which counts credited completions and so double-counts a co-assigned task. */
const distinctTasks = (list: Completion[]) =>
  new Set(list.map((e) => e.task.id)).size;

/** What both day layouts need to draw themselves. Passed down rather than
 *  recomputed so the two agree on ordering to the letter. */
interface DayProps {
  entries: Completion[];
  personIds: string[];
  boardIds: string[];
  boardOf: (id?: string | null) => Board | undefined;
  resolveById: (id: string) => Person | undefined;
  cardFor: (e: Completion) => React.ReactNode;
  /** Which day these entries are, and in which project — the person columns need
   *  both to fetch a standup and to link to its close-out. */
  projectId: string;
  day: string;
  /** This day's standup for a person, when they wrote one. Only the `person`
   *  layout passes it — see `DayByBoard`. */
  writeUpFor?: (uid: string) => DayWriteUp | undefined;
  /** The one column allowed to offer "write it up" — your own, on a recent day you
   *  never wrote up. Null the rest of the time. */
  promptWriteUp?: string | null;
}

/**
 * The DEFAULT day layout: one column per person, and inside each, a small
 * separator per board.
 *
 * Reads as "what did each of us get done today", which is the question the view
 * exists to answer — and unlike the board-first layout it doesn't spend a
 * full-width band per board on a day when one person closed everything.
 *
 * It's also the layout that carries the STANDUP: one column here is exactly one
 * work day for one person, so the prose they wrote at Finish work heads the very
 * set of cards it describes.
 */
function DayByPerson({
  entries,
  personIds,
  boardIds,
  boardOf,
  resolveById,
  cardFor,
  writeUpFor,
  projectId,
  day,
  promptWriteUp,
}: DayProps) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {personIds.map((uid) => {
        const mine = entries.filter(
          (e) => (e.creditedTo ?? NO_ASSIGNEE) === uid,
        );
        return (
          <Column key={uid}>
            <PersonHead
              uid={uid}
              person={resolveById(uid)}
              count={mine.length}
              writeUp={writeUpFor?.(uid)}
              projectId={projectId}
              day={day}
              /* Nothing finished, nothing to write up — an empty day needs no
                 nudge, and a column with no cards is already the message. */
              prompt={uid === promptWriteUp && mine.length > 0}
            />
            <div className="flex-1 space-y-2 p-2">
              {/* Boards in the project's own order, skipping any this person
                  didn't touch — an empty board separator in a personal column
                  says nothing except that the column is mostly padding. */}
              {boardIds.map((boardId) => {
                const rows = mine.filter(
                  (e) => (e.task.boardId ?? "") === boardId,
                );
                if (!rows.length) return null;
                return (
                  <div key={boardId || "none"}>
                    <BoardSeparator
                      board={boardOf(boardId)}
                      count={rows.length}
                    />
                    <div className="space-y-1.5">{rows.map(cardFor)}</div>
                  </div>
                );
              })}
            </div>
          </Column>
        );
      })}
    </div>
  );
}

/**
 * The board-first day layout: a full-width rule per board, cut across by the
 * same person columns.
 *
 * Kept for the days that are actually board-shaped — a release where four people
 * each closed work on three boards reads better with the boards as the rows.
 * Columns are the day's full person list (not just the people on that board), so
 * they line up vertically from one band to the next; that alignment is the whole
 * point of reading it this way.
 */
function DayByBoard({
  entries,
  personIds,
  boardIds,
  boardOf,
  resolveById,
  cardFor,
  projectId,
  day,
}: DayProps) {
  return (
    <div className="space-y-3 overflow-x-auto pb-1">
      {boardIds.map((boardId) => {
        const board = boardOf(boardId);
        const rows = entries.filter((e) => (e.task.boardId ?? "") === boardId);
        return (
          <div key={boardId || "none"} className="min-w-fit">
            {/* A quiet rule rather than a third gradient band: the week and the
                day already carry those, and a third would flatten the hierarchy
                instead of extending it. */}
            <div className="mb-1.5 flex items-center gap-2 border-b border-border pb-1">
              {board ? (
                <Avatar
                  name={board.name}
                  size={16}
                  imageUrl={board.image}
                  color={board.color}
                />
              ) : null}
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted">
                {board?.name ?? "No board"}
              </span>
              <span className="nums text-xs text-faint">
                {distinctTasks(rows)}
              </span>
            </div>

            <div className="flex gap-3">
              {personIds.map((uid) => {
                const mine = rows.filter(
                  (e) => (e.creditedTo ?? NO_ASSIGNEE) === uid,
                );
                return (
                  <Column key={uid}>
                    <PersonHead
                      uid={uid}
                      person={resolveById(uid)}
                      count={mine.length}
                      projectId={projectId}
                      day={day}
                    />
                    <div className="flex-1 space-y-1.5 p-2">
                      {mine.map(cardFor)}
                    </div>
                  </Column>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The column shell — one fixed width for both layouts, so switching between
 *  them doesn't reflow the cards inside. */
function Column({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-[340px] shrink-0 flex-col rounded-xl border border-border bg-surface-2">
      {children}
    </div>
  );
}

/** A person column's header: who, how many — and the standup they wrote for that
 *  day, since a column here IS one person's work day. */
function PersonHead({
  uid,
  person,
  count,
  writeUp,
  projectId,
  day,
  prompt,
}: {
  uid: string;
  person?: Person;
  count: number;
  writeUp?: DayWriteUp;
  projectId: string;
  day: string;
  /** Offer to write the day up — set only on your OWN column, only on a day you
   *  finished something in and never wrote up. */
  prompt?: boolean;
}) {
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        {person ? (
          <Avatar
            name={person.name}
            size={18}
            imageUrl={person.avatarUrl ?? undefined}
            color={person.color}
            ring
          />
        ) : null}
        <span className="truncate text-sm font-semibold tracking-tight text-fg">
          {uid === NO_ASSIGNEE ? "No assignee" : (person?.name ?? "Unknown")}
        </span>
        <span className="nums text-xs text-faint">{count}</span>
      </div>
      {writeUp ? (
        <Standup writeUp={writeUp} projectId={projectId} />
      ) : prompt ? (
        <WriteItUp projectId={projectId} day={day} />
      ) : null}
    </div>
  );
}

/** The little all-caps label both states share. */
const STANDUP_LABEL =
  "text-[10px] font-bold uppercase tracking-[0.12em] text-faint";

/**
 * The day's standup, under the name it belongs to.
 *
 * Closed, it's ONE PLAIN LINE — `previewOf` output, already cut to length on the
 * server. Not markdown clamped with CSS: a standup written to the Finish work
 * prompt opens with a section heading, so a clamped render of it spends its whole
 * height on the word "Progress". A pre-cut string also needs no `line-clamp` over
 * block children, which is the fragile construction it replaces.
 *
 * Open, the prose is fetched — it isn't in the list payload at all (PLAT-403). One
 * fetch per column that someone actually opens, held in local state for as long as
 * the day stays expanded; unmounting and looking again is a re-read, which is
 * honest. `<details>` rather than an open flag in React state: the semantics
 * exactly, keyboard-operable and announced for free.
 */
function Standup({
  writeUp,
  projectId,
}: {
  writeUp: DayWriteUp;
  projectId: string;
}) {
  const [full, setFull] = useState<FullWriteUp | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const onToggle = async (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    // `hasMore` false means the teaser IS the whole standup — nothing to fetch.
    if (
      !e.currentTarget.open ||
      !writeUp.hasMore ||
      full ||
      state === "loading"
    )
      return;
    setState("loading");
    const q = new URLSearchParams({
      projectId,
      day: writeUp.day,
      userId: writeUp.userId,
    });
    try {
      const res = await fetch(`/api/work-days/write-up?${q}`);
      if (!res.ok) throw new Error(String(res.status));
      setFull((await res.json()) as FullWriteUp);
      setState("idle");
    } catch {
      setState("error");
    }
  };

  return (
    <details className="group px-3 pb-2" onToggle={onToggle}>
      {/* `list-none` (plus the WebKit pseudo-element) drops the native marker; the
          caret below stands in for it. */}
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={`${STANDUP_LABEL} group-open:text-muted`}>Standup</span>
        {/* Closed only: open, the full prose renders below and repeating the
            opening line above it reads as a stutter. */}
        <p className="text-xs leading-snug text-muted group-open:hidden">
          {writeUp.preview}
        </p>
        <span className="text-[10px] text-faint group-hover:text-muted">
          {/* Two labels rather than a rotating caret: which way it's about to move
              is the only thing worth saying here. */}
          <span className="inline-flex items-center gap-1 group-open:hidden">
            {writeUp.hasMore ? "Read it" : null}
            <ChevronDown aria-hidden size={11} strokeWidth={2} />
          </span>
          <span className="hidden items-center gap-1 group-open:inline-flex">
            Less
            <ChevronUp aria-hidden size={11} strokeWidth={2} />
          </span>
        </span>
      </summary>

      <div className="mt-1 space-y-1.5">
        {!writeUp.hasMore ? (
          /* The teaser was the lot — show it unclamped and don't invent a fetch. */
          <p className="text-xs leading-snug text-muted">{writeUp.preview}</p>
        ) : state === "loading" ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : state === "error" ? (
          <p className="text-xs text-danger">Couldn’t load the standup.</p>
        ) : (
          <>
            {full?.summary?.trim() ? (
              <Markdown size="xs" tone="muted">
                {full.summary}
              </Markdown>
            ) : null}
            {full?.bullets?.trim() ? (
              /* The day's non-task points, kept apart from the prose the way
                 Finish work captures them — "out Thursday" is not part of the
                 write-up. Ruled off only when there's prose above to rule off. */
              <div
                className={
                  full.summary?.trim() ? "border-t border-border pt-1.5" : ""
                }
              >
                <Markdown size="xs" tone="muted">
                  {full.bullets}
                </Markdown>
              </div>
            ) : null}
            {full && !full.sealed ? (
              /* Not sealed = no later day drafted yet, so this is still
                 correctable in Finish work. Worth knowing before you quote it. */
              <p className="text-[10px] uppercase tracking-wide text-faint">
                Draft
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * The gap where a standup should be: you finished work this day and never wrote it
 * up.
 *
 * The close-out's whole risk is a ritual nobody keeps, and this is the one screen
 * that can see the omission — it already knows you closed four things. Held to
 * YOUR own column and to the days still expanded by default, so it stays a
 * reminder to yourself rather than a scoreboard, and an unwritten day three weeks
 * back says nothing at all.
 */
function WriteItUp({ projectId, day }: { projectId: string; day: string }) {
  return (
    <div className="px-3 pb-2">
      <span className={STANDUP_LABEL}>Standup</span>
      <a
        href={`/day?projectId=${encodeURIComponent(projectId)}&day=${day}`}
        className="block text-xs text-accent underline underline-offset-2 hover:opacity-80"
      >
        Write it up →
      </a>
    </div>
  );
}

/** A board's separator INSIDE a person's column — the same dot-and-label rule
 *  the status separators use, in the board's own color, so it reads as a cut
 *  through the column rather than as another card. */
function BoardSeparator({
  board,
  count,
}: {
  board?: Board;
  count: number;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 pt-0.5">
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: board?.color ?? "var(--color-faint)" }}
      />
      <span className="truncate text-[11px] font-bold uppercase tracking-wide text-muted">
        {board?.name ?? "No board"}
      </span>
      <span className="nums text-[11px] text-faint">{count}</span>
    </div>
  );
}

/** One completion. The card is the same one the boards use, minus the green
 *  wash and the drag handle — there is nothing to drop onto in a log. */
function DoneCard({
  entry,
  inStore,
  onOpen,
}: {
  entry: Completion;
  /** Archived tasks are in the log but not in the workspace store, and the
   *  detail modal reads the store — so don't offer a click that opens nothing. */
  inStore: boolean;
  onOpen: () => void;
}) {
  return (
    <div title={inStore ? undefined : "Archived — open it from the Archived view"}>
      <TaskCard
        task={entry.task}
        neutralDone
        // A log, not a board: no dragging, and no DELETE / triage arrows (the
        // sweep is the Archive-done button). Half these cards are archived and not
        // even in the store, so those keys would act on nothing anyway.
        readOnly
        onOpen={inStore ? onOpen : () => {}}
      />
    </div>
  );
}
