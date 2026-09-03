"use client";

/**
 * A canvas Section — a Figma-style titled container bound to a board, whose
 * lines are that board's LIVE tasks. Two modes, ESC is the boundary:
 *
 *   • authoring — a role-cycling line editor. TAB cycles a line task → subtask
 *     → [desc]; SHIFT+TAB reverses. ENTER adds a line of the same role; ENTER on
 *     an empty line pops out one level. Task/subtask lines stay bound to their
 *     task id, so re-editing patches the same task instead of duplicating it.
 *   • committed — the tasks as interactive cards (status, assignees, open, drag).
 *
 * Before it's bound (`data.boardId`) the Section shows a name input that
 * autosuggests existing boards (or creates a new one). Task reads/writes go
 * through useWorkspace(); the commit is one-to-three /api/tasks/bulk batches.
 *
 * A section can also carry a name of its OWN (`data.name`, set by double-clicking
 * the header title). When set it takes the title slot and the bound board's name
 * (`node.content`) trails it inline, dimmed and regular weight.
 */

import {
  AlignJustify,
  ArrowUpToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Inbox,
  LayoutGrid,
  ListTodo,
  Pencil,
  Rows3,
  Star,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useOthers, useSelf, useUpdateMyPresence, shallow } from "@liveblocks/react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";
import { type TaskUnit } from "@/lib/outline";
import { NO_FILTER, filterUnits, type RenderFilter } from "@/lib/task-filters";
import { useAssignOnCreate } from "./useAssignOnCreate";
import type { TaskStatus, Importance, TaskPlacement } from "@/lib/types";
import { useWorkspace, type DropPos, type TaskNode } from "./WorkspaceContext";
import { useSectionMembership } from "./SectionMembershipContext";
import { refId } from "@/lib/ref-id";
import { resolveRowLock, type RowClaim, type RowLock } from "./useRowLock";

/** How long a takeover waits for the old owner to yield before going ahead
 *  anyway. Their tab may be asleep, frozen or gone — a row nobody can take is a
 *  worse outcome than one taken a beat early. */
const TAKEOVER_WAIT_MS = 1500;
import { useEventCallback } from "./useEventCallback";
import { useDragSessionEnd } from "./useDragSessionEnd";
import { HEIGHT_COMMIT_MS } from "./canvasWrites";
import {
  isInboxNode,
  systemGroupOf,
  PLACEMENT_TITLE,
  type SystemGroup,
} from "@/lib/sections";
import { compareTaskOrder } from "@/lib/task-order";
import { TaskCardBody } from "./TaskCardBody";
import { OutlineEditor, type OutlinePeer } from "./OutlineEditor";
import { useOutlineDraft } from "./useOutlineDraft";
import { AnchoredPopover } from "./AnchoredPopover";
import { useTaskCardShortcuts } from "./useTaskCardShortcuts";
import { IMPORTANCE_CARD } from "@/lib/importance";
import { STATUS_TONE, STATUS_CANVAS_BADGE } from "@/lib/statuses";

export const NEW_SECTION_SIZE = { width: 420, height: 320 };

/** Floor height for a section card so an empty/naming one isn't a sliver. Above
 *  this the card grows to fit its outline/tasks (`height: auto`), and the height
 *  is mirrored back into stored `node.height`. */
export const MIN_SECTION_HEIGHT = 140;

const SECTION_DND_MIME = "application/x-section-task";

/** How each machine-managed tray labels itself in its header. */
const TRAY_GLYPH: Record<SystemGroup, { icon: LucideIcon; hint: string }> = {
  inbox: { icon: Inbox, hint: "Inbox — untriaged, nobody has filed these yet" },
  today: { icon: Sun, hint: "Today — the shortlist you committed to this morning" },
  thisWeek: { icon: Star, hint: "This week — what you mean to do this week" },
  backlog: { icon: ListTodo, hint: "Backlog — triaged, not scheduled" },
  later: { icon: Clock, hint: "Later — deliberately deferred" },
  doneThisWeek: {
    icon: Check,
    hint: "Done this week — finished, delete again to archive",
  },
};

type Mode = "naming" | "authoring" | "committed";

/** The task TREE for ONE section, read from the live workspace. Which tasks
 *  belong here is resolved for the whole canvas at once (see
 *  `buildSectionMembership`): a task pinned to this node, or — if this node is
 *  an INBOX lane — any unpinned task on its board. Arbitrary nesting depth. */
function useSectionUnits(sectionId: string): TaskUnit[] {
  const { childIndex, nodeIndex, taskMap } = useWorkspace();
  const { bySection } = useSectionMembership();
  // Which of THIS section's tasks changed, as a primitive.
  //
  // `taskMap` gets a new identity whenever any one task anywhere changes, so
  // depending on it rebuilt every section's unit tree for an edit to a task in
  // one of them — ~223 objects allocated per keystroke while someone typed in an
  // outline (TD-132). Only a member of this section can change what this tree
  // looks like, so the dependency is the identity of those members' task objects:
  // O(members) reference lookups here, and summed over the canvas that is
  // O(tasks) once, not O(sections × tasks).
  const members = bySection.get(sectionId);
  let contentSig = "";
  if (members) {
    const parts: number[] = [];
    for (const id of members) {
      const t = taskMap[id];
      parts.push(t ? refId(t) : 0);
    }
    contentSig = parts.join(",");
  }
  return useMemo(() => {
    const members = bySection.get(sectionId);
    if (!members) return [];
    // Pre-sorted by the index, so this is a filter and never a sort — and it
    // walks this parent's OWN children, not every task on the canvas. The naive
    // version cost O(sections x tasks x members) and every task change re-paid
    // it (TD-132).
    const childrenOf = (parentId: string) =>
      (childIndex.get(parentId) ?? []).filter((n) => members.has(n.id));
    const build = (rows: readonly TaskNode[]): TaskUnit[] =>
      rows.map((n) => {
        const t = taskMap[n.id];
        return {
          taskId: n.id,
          title: t?.title ?? "",
          description: t?.description ?? "",
          children: build(childrenOf(n.id)),
          // Carried so a card can render without the whole `taskMap`, and so the
          // memo boundary below has a cheap identity to compare — see `sameUnit`.
          task: t,
        };
      });
    // Roots of THIS section: top-level tasks, plus any whose parent isn't here
    // too — a subtask whose parent was dragged into another section would
    // otherwise have no row to hang off and would vanish. Walked over the
    // section's OWN members rather than every task on the canvas, then put back
    // into display order.
    const roots: TaskNode[] = [];
    for (const id of members) {
      const n = nodeIndex.get(id);
      if (n && (n.parentId === null || !members.has(n.parentId))) roots.push(n);
    }
    roots.sort(compareTaskOrder);
    return build(roots);
    // `taskMap` is read inside but deliberately NOT a dependency: `contentSig`
    // already captures the only part of it that can change this tree (the identity
    // of this section's own members). Adding it back would restore the
    // whole-canvas rebuild this exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, childIndex, nodeIndex, contentSig, bySection]);
}

export function SectionNode({
  node,
  selected,
  smooth = true,
  onPointerDown,
  onPatch,
  onResize,
  isMaster = false,
  masterSection = null,
  onRemove,
  filter = NO_FILTER,
}: {
  node: CanvasNodeT;
  selected: boolean;
  /** Ease position changes (remote moves). Off while YOU drag it, so your own
   *  drag stays glued to the cursor with no rubber-banding. */
  smooth?: boolean;
  /** Canvas drag handle — attach to the header only. */
  onPointerDown: (e: ReactPointerEvent) => void;
  /** Persist node fields — the title (content) and data.boardId. */
  onPatch: (patch: { content?: string; data?: Record<string, unknown> }) => void;
  /** Report the section's measured height so stored `node.height` follows content. */
  onResize?: (height: number) => void;
  /** Present for prop-compatibility with CanvasNode; unused now. */
  canvasName?: string;
  /** This section is its board's master — the target of siblings' Send buttons.
   *  Derived from sitting inside the starred THIS WEEK group, not toggled here. */
  isMaster?: boolean;
  /** The master section for this section's board (if any and not this one). */
  masterSection?: { id: string; name: string } | null;
  /** Remove this node from the canvas (used after sending its cards away). */
  onRemove?: () => void;
  /** Show only some cards — one person's work, some boards' work, or both
   *  (TD-59, widened in TD2-216). Render-only: it decides what's DRAWN and
   *  suppresses the resize→storage mirror below, and never touches Liveblocks
   *  storage. Text mode shows the same narrowed tree (TD2-194); what keeps that
   *  safe is `scopeNodes`, which stays whole. */
  filter?: RenderFilter;
}) {
  const ws = useWorkspace();
  const boardId = (node.data?.boardId as string | undefined) ?? null;
  // Who created this section. The board-picker (naming mode) is private to the
  // creator — peers see a placeholder until a board is bound. Legacy sections
  // with no `createdBy` stay bindable by anyone (the `!createdBy` fallback).
  const createdBy = node.data?.createdBy as string | undefined;
  const myId = useSelf((me) => me.id);
  const isCreator = !createdBy || createdBy === myId;
  // A section's tasks are scoped by this stable id (the canvas node's id), not
  // by its board — so it starts empty and stays separate from sibling sections.
  const sectionId = node.id;
  const units = useSectionUnits(sectionId);
  /* What this section actually draws — and, since TD2-194, what text mode edits
     too: a filter that card mode honours and text mode ignores reads as broken.
     It is safe to author against because the outline deletes only a line someone
     deleted by hand and positions are fractional midpoints, so a row it can't
     see can be neither removed nor renumbered; `sectionNodes` (the save SCOPE,
     below) stays whole, which is what keeps the hidden rows addressable. */
  const visibleUnits = useMemo(
    () => filterUnits(units, filter.keep),
    [units, filter],
  );
  /** The cards this section draws at TOP level, in display order — what an insert
   *  between two cards is positioned against. Taken from the rendered tree, so it
   *  includes a subtask whose parent lives in another section (which renders as a
   *  root here, see `useSectionUnits`). */
  const rootIds = useMemo(
    () => units.map((u) => u.taskId).filter((id): id is string => !!id),
    [units],
  );
  // An INBOX lane: a tray showing its board's UNPINNED tasks, so that anything
  // created from the API, MCP or a board view is visible here instead of nowhere.
  // Cards land in it by having no pin, which is why `pin` is null for a lane —
  // pinning to it would immediately take the card out of it again.
  const isInbox = isInboxNode(node);
  // Which machine-managed tray this is, if any (INBOX / BACKLOG / LATER / DONE
  // THIS WEEK). The reconciler owns these: they can't be renamed onto a board or
  // sent away and deleted, because it would just rebuild them.
  const systemKind = systemGroupOf(node);
  const pin = isInbox ? null : sectionId;
  const { bySection } = useSectionMembership();
  const siblingIds = useMemo(
    () => bySection.get(sectionId) ?? new Set<string>(),
    [bySection, sectionId],
  );
  /** Every task node this section holds, all depths — read from the resolved
   *  membership, so it's the same list whichever view mode is showing. */
  const sectionNodes = useMemo(
    () => ws.nodes.filter((n) => siblingIds.has(n.id)),
    [ws.nodes, siblingIds],
  );

  // Soft field-lock (presence): while a user authors this section's outline they
  // publish `editing`, and peers show a lock + can't open the outline — so two
  // people don't batch-save the same section over each other. Presence is
  // ephemeral, so the lock auto-releases if their tab closes.
  //
  // Both subscriptions below are deliberately NARROW. `useMyPresence()` returns
  // the value as well as the updater, so it re-renders on every presence write —
  // including your own cursor, which is broadcast on every pointermove; and a
  // bare `useOthers()` re-renders on ANY peer's presence change, cursors
  // included. With a canvas full of sections that made panning unusable, and a
  // memo boundary on the node can't help — the subscription is in here.
  // `useUpdateMyPresence` doesn't subscribe at all, and a selector + `shallow`
  // re-renders only when this section's own lock actually changes.
  const updateMyPresence = useUpdateMyPresence();
  const remoteEditor = useOthers((others) => {
    const peer = others.find((o) => o.presence.editing?.taskId === sectionId);
    return peer
      ? { name: peer.info?.name ?? "Someone", color: peer.info?.color ?? "#888" }
      : null;
  }, shallow);
  /** Who created this section, for the pre-bind placeholder. A primitive, so it
   *  compares by value and cursors never touch it. */
  const creatorName = useOthers(
    (others) => others.find((o) => o.id === createdBy)?.info?.name ?? "Someone",
  );

  // Who else is in THIS section's outline, and where their caret is.
  //
  // The selector returns a STRING, not a Map: a primitive compares by value, so
  // this re-renders only when this section's own outline presence changes —
  // never on a peer's canvas cursor, which is broadcast on every pointermove and
  // once made panning unusable (TD-132). Caret motion does re-render this one
  // section, at the ~60ms publish throttle below; that's a section with a handful
  // of rows, not every section on the canvas.
  const peerSig = useOthers((others) =>
    others
      .map((o) => {
        const e = o.presence.editing;
        if (!e || e.taskId !== sectionId || !e.row) return "";
        return [
          e.row,
          e.caret ?? "",
          e.len ?? "",
          o.info?.name ?? "Someone",
          o.info?.color ?? "#888",
          o.connectionId,
          e.since ?? 0,
          e.typingAt ?? 0,
          e.override ?? "",
        ].join("\u0001");
      })
      .filter(Boolean)
      .join("\u0002"),
  );
  const peerFields = useMemo(() => {
    const map = new Map<string, OutlinePeer[]>();
    if (!peerSig) return map;
    for (const entry of peerSig.split("\u0002")) {
      const [row, caret, len, name, color] = entry.split("\u0001");
      const list = map.get(row) ?? [];
      list.push({
        name,
        color,
        caret: caret === "" ? undefined : Number(caret),
        len: len === "" ? undefined : Number(len),
      });
      map.set(row, list);
    }
    return map;
  }, [peerSig]);

  /** Peers' row claims, for `resolveRowLock`. Same string, parsed for ownership
   *  rather than for drawing. */
  const peerClaims = useMemo<RowClaim[]>(() => {
    if (!peerSig) return [];
    return peerSig.split("\u0002").map((entry) => {
      const [row, , , name, color, id, since, typingAt, override] = entry.split("\u0001");
      return {
        id: Number(id),
        name,
        color,
        field: row,
        since: Number(since),
        typingAt: Number(typingAt),
        override: override || null,
      };
    });
  }, [peerSig]);

  // Publish our own caret, throttled — presence is cheap but not free, and a
  // trailing update makes sure the final resting position always lands.
  const [myField, setMyField] = useState<string | null>(null);
  const caretThrottle = useRef<{ at: number; timer: ReturnType<typeof setTimeout> | null }>({
    at: 0,
    timer: null,
  });
  // The claim behind the lock: `since` is stamped when we ENTER a row (so
  // seniority is per row, not per keystroke), `typingAt` only when we actually
  // type (so a parked caret stops blocking), and `override` while we are
  // deliberately taking a row from someone.
  const claimRef = useRef<{ field: string | null; since: number; typingAt: number }>({
    field: null,
    since: 0,
    typingAt: 0,
  });
  const [override, setOverride] = useState<string | null>(null);
  const overrideRef = useRef<string | null>(null);
  useEffect(() => void (overrideRef.current = override), [override]);
  const publishCaret = useCallback(
    (field: string | null, offset: number, len: number, typed = false) => {
      setMyField(field);
      const claim = claimRef.current;
      if (claim.field !== field) {
        // New row: a fresh claim, and any takeover intent belonged to the old one.
        claim.field = field;
        claim.since = Date.now();
        claim.typingAt = typed ? Date.now() : 0;
        if (overrideRef.current) {
          overrideRef.current = null;
          setOverride(null);
        }
      } else if (typed) {
        claim.typingAt = Date.now();
      }
      const send = () => {
        caretThrottle.current.at = Date.now();
        updateMyPresence({
          editing: {
            taskId: sectionId,
            field: "outline",
            // From the ref, not the captured argument: the throttle can drop a
            // call, and the send that does go must describe where we are NOW.
            row: claimRef.current.field ?? undefined,
            caret: offset,
            len,
            since: claimRef.current.since,
            typingAt: claimRef.current.typingAt,
            override: overrideRef.current,
          },
        });
      };
      const since = Date.now() - caretThrottle.current.at;
      if (since >= 60) {
        if (caretThrottle.current.timer) {
          clearTimeout(caretThrottle.current.timer);
          caretThrottle.current.timer = null;
        }
        send();
        return;
      }
      if (caretThrottle.current.timer) return;
      caretThrottle.current.timer = setTimeout(() => {
        caretThrottle.current.timer = null;
        send();
      }, 60 - since);
    },
    [sectionId, updateMyPresence],
  );

  // Task ids this authoring session is allowed to delete = the section's tasks
  // when authoring began, plus any it creates. Guards against deleting a task a
  // PEER adds to this section while we're editing a stale local outline.
  // Busy flag for the header's BULK sweeps (done-and-archive, delete-all). The
  // outline's own saving state comes from `useOutlineDraft`; the header spinner
  // shows either.
  const [busy, setBusy] = useState(false);
  // `ws.bulk`, not a local fetch: it chunks past the server's per-batch cap and
  // reports any op that didn't apply.
  const bulk = ws.bulk;

  // An INBOX lane never goes through naming: its board is fixed by the
  // reconciler, and the "No board" lane is legitimately board-less.
  const [mode, setMode] = useState<Mode>(boardId || systemKind ? "committed" : "naming");
  // `mode` is seeded from `boardId` only once, so a peer sitting in naming (the
  // placeholder) when the author picks a board would stay stuck on the pre-bind
  // view. Derive the DISPLAYED mode from the live `boardId` instead of mutating
  // state in an effect: once bound, everyone renders committed. The state
  // machine (authoring transitions, saves) still keys off the real `mode`.
  const viewMode: Mode =
    (boardId || systemKind) && mode === "naming" ? "committed" : mode;
  // Text-mode display preference (session-only): descriptions grow up to 6 rows
  // by default; toggled to unbounded via the header button. Not persisted.
  const [descExpanded, setDescExpanded] = useState(false);
  // The outline machine — shared with the project Boards view, which runs the
  // same text mode over a board × bucket column. This section supplies the tree
  // to seed from, the tasks the list owns, and where a new root line is filed
  // (its own pin); the hook owns the rows, the keys, the autosave and the
  // delete-safety rules. See `useOutlineDraft`.
  const outlineTarget = useMemo(() => ({ canvasSectionId: pin }), [pin]);
  // Do we hold a field? A peer's lock means no — and so does a takeover still in
  // flight, where the row is claimed but its real text hasn't landed yet. Both
  // sources are declared below this hook call, so they are read through refs and
  // the predicate itself never changes identity.
  const lockForRef = useRef<((field: string | null) => RowLock) | null>(null);
  const takingFieldRef = useRef<string | null>(null);
  const ownsFieldStable = useCallback((field: string) => {
    if (takingFieldRef.current === field) return false;
    return lockForRef.current?.(field).state !== "peer";
  }, []);
  const { rows, saving, inputRefs, setText, onRowKeyDown, seed, flush, adoptField, flushSends } =
    useOutlineDraft({
      active: mode === "authoring",
      units: visibleUnits,
      // The WHOLE section, filter or no filter: this is the set a save may move
      // and delete within, and the parent/position baseline it computes against.
      // Narrowing it would hand the outline a world with a hole in it, and a
      // hidden sibling would stop being addressable the moment a filter was on.
      scopeNodes: sectionNodes,
      boardId,
      rootTarget: outlineTarget,
      /* A line typed into a FILTERED outline is for the person being filtered
         for (TD2-193) — without this it would bind and vanish in the same
         keystroke. The card composers put that behind a checkbox; a text row
         has nowhere to hang one, and "the list I am writing in shows only Sam's
         work" is the only reading a new line there has. */
      assigneeIds: filter.assigneeId ? [filter.assigneeId] : undefined,
      // Only broadcast keystrokes when someone else is actually in this outline —
      // a peer applying a text patch rebuilds every section's unit tree on their
      // canvas, so it isn't worth paying while you type alone.
      peersPresent: remoteEditor !== null,
      // The re-seed protects the row the caret is in; this says when that right
      // exists. Read through refs, because `lockFor` changes identity on every
      // presence tick and this must not re-arm anything.
      ownsField: ownsFieldStable,
      onLeave: () => setMode("committed"),
    });
  const enterAuthoring = useCallback(() => {
    seed();
    setMode("authoring");
  }, [seed]);

  /* ---------------- per-row locks ---------------- */
  // One editor per row at a time. Ownership is resolved from presence alone (see
  // `useRowLock`), so there is nothing to release: a claim dies with its tab.
  const myConnId = useSelf((me) => me.connectionId) ?? -1;
  // A PARKED lock becomes takeable purely by time passing, with no event to
  // trigger a render — so tick while peers are in this outline, and only then. An
  // idle canvas must not wake up once a second.
  const [, tickLocks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (mode !== "authoring" || !peerClaims.length) return;
    const t = setInterval(tickLocks, 1000);
    return () => clearInterval(t);
  }, [mode, peerClaims.length, tickLocks]);

  const lockFor = useCallback(
    (field: string | null): RowLock => {
      const mine: RowClaim[] = myField
        ? [
            {
              id: myConnId,
              name: "You",
              color: "#000",
              field: myField,
              since: claimRef.current.since,
              typingAt: claimRef.current.typingAt,
              override,
            },
          ]
        : [];
      return resolveRowLock(field, [...peerClaims, ...mine], myConnId, Date.now());
    },
    [peerClaims, myField, myConnId, override],
  );

  // Keep the refs the `ownsField` predicate reads pointed at the live values.
  useEffect(() => {
    lockForRef.current = lockFor;
  }, [lockFor]);

  /** A takeover in progress: claimed, but NOT yet editable. `pending` is the
   *  keystroke that asked for a parked row, held rather than applied to text we
   *  were about to replace. */
  const [taking, setTaking] = useState<{
    field: string;
    pending?: { insert: string; at: number };
  } | null>(null);
  /** A field whose text was NOT what we thought when we took it — flagged briefly
   *  so nobody starts typing over a line that rewrote itself. */
  const [changedField, setChangedField] = useState<string | null>(null);

  /**
   * Take a row from whoever holds it.
   *
   * Deliberately NOT instant. Publishing the claim makes us the owner on the next
   * render, and if the row went editable there we would be typing over our own
   * click-time snapshot — the previous owner has kept typing since, and their
   * characters reach us as patches our focused row refuses to render. So the row
   * stays read-only through a short "taking over…" beat and only opens once we
   * hold their current text (`adoptField`, resolved in the effect below).
   *
   * The intent is published immediately even so: the point of pressing this is
   * that the OTHER side finds out now — that is what makes them flush and yield.
   */
  const takeOver = useCallback(
    (field: string, pending?: { insert: string; at: number }) => {
      const at = Date.now();
      overrideRef.current = field;
      setOverride(field);
      claimRef.current = { field, since: at, typingAt: at };
      // Synchronously, not in an effect: the draft's re-seed runs before this
      // component's effects do, and it must not spend a pass protecting a row we
      // have just declared we don't hold yet.
      takingFieldRef.current = field;
      setTaking({ field, pending });
      updateMyPresence({
        editing: {
          taskId: sectionId,
          field: "outline",
          row: field,
          since: at,
          typingAt: at,
          override: field,
        },
      });
    },
    [sectionId, updateMyPresence],
  );

  // Completing a takeover. We cannot observe the old owner's flush resolving — but
  // we do not need to. Their yield path puts the throttled keystrokes on the wire
  // FIRST and drops the claim second (see the yield effect below), so their claim
  // disappearing means their last characters are already ahead of it and
  // `taskMap` has them. That is the signal, and it costs one hop, not one write.
  //
  // The timeout is not a nicety: a frozen, sleeping or offline tab never yields,
  // and a row that can never be taken is worse than a stale one.
  useEffect(() => {
    if (!taking) return;
    const done = () => {
      const { changed } = adoptField(taking.field, taking.pending);
      takingFieldRef.current = null;
      setTaking(null);
      if (changed) setChangedField(taking.field);
    };
    if (!peerClaims.some((c) => c.field === taking.field)) {
      done();
      return;
    }
    const t = setTimeout(done, TAKEOVER_WAIT_MS);
    return () => clearTimeout(t);
  }, [taking, peerClaims, adoptField]);

  // Clear the "this line changed" flag on its own timer, so it never outlives the
  // moment it is explaining.
  useEffect(() => {
    if (!changedField) return;
    const t = setTimeout(() => setChangedField(null), 4000);
    return () => clearTimeout(t);
  }, [changedField]);

  // Yielding: a peer has named OUR row in their `override`.
  //
  // Two things have to happen, and their ORDER is the whole point. The taker is
  // sitting read-only waiting for our last characters, and what tells them we are
  // done is our claim disappearing — so the characters must be on the wire before
  // the claim goes, or they would start typing over the tail of our sentence.
  //
  //   1. `flushSends()` — synchronous, puts the throttled keystrokes into a
  //      `task-patch` broadcast the taker applies with no DB read. THEN release
  //      the claim. One hop, so the handover feels immediate.
  //   2. `flush()` — the Postgres write, awaited only because the notice we show
  //      afterwards promises the text was saved. The taker never waits on this;
  //      making them wait would have cost them a second on every takeover.
  const [yieldedTo, setYieldedTo] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "authoring" || !myField) return;
    const taker = peerClaims.find((c) => c.override === myField);
    if (!taker) return;
    let hide: ReturnType<typeof setTimeout> | null = null;
    flushSends();
    void flush().then(() => {
      setYieldedTo(taker.name);
      hide = setTimeout(() => setYieldedTo(null), 3000);
    });
    // Blurring is what releases our claim (see the blur path in `OutlineEditor`,
    // which reports a null field), so no separate teardown of `myField` here.
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      [...inputRefs.current.values()].some((node) => node === active)
    ) {
      active.blur();
    }
    claimRef.current = { field: null, since: 0, typingAt: 0 };
    updateMyPresence({
      editing: { taskId: sectionId, field: "outline", since: 0, typingAt: 0, override: null },
    });
    return () => {
      if (hide) clearTimeout(hide);
    };
  }, [peerClaims, myField, mode, flush, flushSends, inputRefs, sectionId, updateMyPresence]);


  /* ---------------- content-driven height ---------------- */
  // Mirror the section card's rendered height into stored `node.height`, so the
  // card grows/shrinks to fit its outline or task cards instead of being a fixed
  // scroll box. Same pattern as the text CanvasNode: latest height/callback live
  // in refs so the observer is created once, and a round-guard avoids write loops
  // and jitter. Committing an outline can add/remove rows, so height tracks that.
  const boxRef = useRef<HTMLDivElement>(null);
  const onResizeRef = useRef(onResize);
  const heightRef = useRef(node.height);
  // A filter (TD-59/TD2-216) shrinks the rendered card list without the
  // section actually being smaller — never mirror that measurement into
  // shared storage, or one viewer's filter would resize the section live for
  // everyone else in the room. Kept in a ref (not a dep) for the same reason
  // as the two above: the observer is created once.
  const filterActiveRef = useRef(filter.active);
  useEffect(() => {
    onResizeRef.current = onResize;
    heightRef.current = node.height;
    filterActiveRef.current = filter.active;
  });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // Debounced for the same reason as the text card's (TD2-185): a section
    // growing by a row fires this several times, and every intermediate height
    // is a billed storage update from every client in the room.
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        if (filterActiveRef.current) return;
        const h = el.offsetHeight;
        if (Math.round(h) !== Math.round(heightRef.current)) onResizeRef.current?.(h);
      }, HEIGHT_COMMIT_MS);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // Publish a soft outline-lock while authoring this section, so peers see it's
  // being edited and are blocked from opening it. Cleared on leave/unmount
  // (Liveblocks also drops it automatically if this tab disconnects).
  useEffect(() => {
    if (mode !== "authoring") return;
    updateMyPresence({ editing: { taskId: sectionId, field: "outline" } });
    return () => updateMyPresence({ editing: null });
  }, [mode, sectionId, updateMyPresence]);


  /* ---------------- the section's own name ---------------- */
  // `data.name` is optional and lives alongside the bound board (`node.content`
  // stays the BOARD's name). Double-clicking the header title opens this inline
  // field; committing happens on blur only (Enter/Escape just blur), with
  // `cancelRenameRef` marking an Escape so it discards instead of saving.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const cancelRenameRef = useRef(false);

  const startRename = () => {
    cancelRenameRef.current = false;
    setNameDraft(((node.data?.name as string | undefined) ?? "").trim());
    setRenaming(true);
  };

  const commitName = (raw: string) => {
    setRenaming(false);
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const next = raw.trim();
    const current = ((node.data?.name as string | undefined) ?? "").trim();
    if (next === current) return;
    const data = { ...(node.data ?? {}) };
    // Clearing the field drops the key entirely, so the header falls back to
    // showing just the board name (as it did before a name was ever set).
    if (next) data.name = next;
    else delete data.name;
    onPatch({ data });
  };

  /* ---------------- binding (naming) ---------------- */
  const bindBoard = (id: string, name: string) => {
    onPatch({ content: name, data: { ...(node.data ?? {}), boardId: id } });
    setMode("committed");
    // Jump straight into authoring so you can start typing tasks. A brand-new
    // section has no tasks, so seeding gives the single empty line and an empty
    // deletable set.
    requestAnimationFrame(() => {
      enterAuthoring();
    });
  };

  /* ---------------- send everything to the master section ------------- */
  // Re-group this section's cards onto its board's master section (placed on
  // top), then remove this now-empty section from the canvas. Source and master
  // share a board, so this only re-pins and reorders — no board move.
  const sendToMaster = useCallback(async () => {
    if (!boardId || !masterSection) return;

    const n = sectionNodes.length;
    if (
      !confirm(
        n
          ? `Send ${n} card${n === 1 ? "" : "s"} to the top of “${masterSection.name}” and delete this section?`
          : `Delete this empty section?`,
      )
    )
      return;

    setBusy(true);
    try {
      if (n) {
        const topLevel = (members: Set<string>) =>
          ws.nodes
            .filter((nd) => nd.parentId === null && members.has(nd.id))
            .sort((a, b) => a.position - b.position)
            .map((nd) => nd.id);
        const sourceTop = topLevel(siblingIds);
        const masterTop = topLevel(bySection.get(masterSection.id) ?? new Set());

        const ops: unknown[] = [];
        // Re-pin every top-level source card onto the master section; nested ones
        // inherit their parent's placement, so they need no write of their own.
        for (const id of sourceTop)
          ops.push({ op: "update", id, patch: { canvasSectionId: masterSection.id } });
        // Reassert dense top-level order: source cards first (= on top), then
        // the master's existing cards. Nested tasks keep their parent/order.
        [...sourceTop, ...masterTop].forEach((id, i) =>
          ops.push({ op: "move", id, target: { position: i } }),
        );

        await bulk(ops);
        await ws.refresh();
      }
      onRemove?.();
    } catch (err) {
      console.error("[section] send-to-master failed", err);
    } finally {
      setBusy(false);
    }
  }, [boardId, masterSection, ws, bulk, onRemove, sectionNodes, siblingIds, bySection]);

  /* ---------------- bulk actions on the whole section ---------------- */
  /** Mark every card in this section done, then archive them. One ordered batch:
   *  `archive` refuses a task that isn't done, so the completes have to land
   *  first — and it cascades to subtrees, so only the roots need archiving. */
  const bulkDoneAndArchive = useCallback(async () => {
    const n = sectionNodes.length;
    if (!n) return;
    if (
      !confirm(
        `Mark ${n} card${n === 1 ? "" : "s"} done and archive them? ` +
          `They move to the Archived view and can be restored later.`,
      )
    )
      return;
    setBusy(true);
    try {
      const ops: unknown[] = [];
      for (const nd of sectionNodes)
        if (nd.status !== "done") ops.push({ op: "complete", id: nd.id, done: true });
      // Roots of this section: a card whose parent isn't here too (or has none).
      // Archiving one takes its whole subtree with it.
      for (const nd of sectionNodes)
        if (nd.parentId === null || !siblingIds.has(nd.parentId))
          ops.push({ op: "archive", id: nd.id });
      await bulk(ops);
      await ws.refresh();
    } catch (err) {
      console.error("[section] bulk done+archive failed", err);
    } finally {
      setBusy(false);
    }
  }, [sectionNodes, siblingIds, bulk, ws]);

  /** Re-file every card in this section into another canvas group — the header's
   *  "Move to…". Only the ROOTS are written: a subtask carries no pin of its own
   *  and follows its parent's placement, exactly as it does on a drag.
   *
   *  `ws.fileTasks` rather than a loop of `sendToPlacement`: one bulk batch and
   *  one refetch, and it states no board, so this only re-pins — the cards stay
   *  on the board this section is bound to. */
  const bulkMoveTo = useCallback(
    async (to: TaskPlacement) => {
      const roots = sectionNodes
        .filter((nd) => nd.parentId === null || !siblingIds.has(nd.parentId))
        .map((nd) => nd.id);
      if (!roots.length) return;
      setBusy(true);
      try {
        await ws.fileTasks(roots, to);
      } catch (err) {
        console.error("[section] bulk move failed", err);
      } finally {
        setBusy(false);
      }
    },
    [sectionNodes, siblingIds, ws],
  );

  /** Archive the cards in this section that are ALREADY done, leaving the rest
   *  where they are — the sweep a part-finished tray wants, as opposed to
   *  "Done and archive", which completes everything first.
   *
   *  Only done cards that aren't already inside another done card being archived
   *  get an op: `archive` cascades to the whole subtree. */
  const bulkArchiveDone = useCallback(async () => {
    const done = sectionNodes.filter((nd) => nd.status === "done");
    if (!done.length) return;
    if (
      !confirm(
        `Archive ${done.length} done card${done.length === 1 ? "" : "s"} from this section? ` +
          `They move to the Archived view (with their subtasks) and can be restored later.`,
      )
    )
      return;
    setBusy(true);
    try {
      const byId = new Map(sectionNodes.map((nd) => [nd.id, nd]));
      const doneIds = new Set(done.map((nd) => nd.id));
      const coveredByAncestor = (nd: (typeof sectionNodes)[number]) => {
        let p = nd.parentId;
        while (p && byId.has(p)) {
          if (doneIds.has(p)) return true;
          p = byId.get(p)!.parentId;
        }
        return false;
      };
      const roots = done.filter((nd) => !coveredByAncestor(nd));
      await bulk(roots.map((nd) => ({ op: "archive", id: nd.id })));
      await ws.refresh();
    } catch (err) {
      console.error("[section] bulk archive-done failed", err);
    } finally {
      setBusy(false);
    }
  }, [sectionNodes, bulk, ws]);

  /** Delete every card in this section, for good. Deepest-first, so a parent is
   *  gone only once its children are — otherwise `deleteTask` would promote them
   *  to root (its single-task behaviour) before we got to them. */
  const bulkDelete = useCallback(async () => {
    const n = sectionNodes.length;
    if (!n) return;
    if (
      !confirm(
        `Delete ${n} card${n === 1 ? "" : "s"} from this section? This can’t be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      const byId = new Map(sectionNodes.map((nd) => [nd.id, nd]));
      const depth = (nd: (typeof sectionNodes)[number]) => {
        let d = 0;
        let p = nd.parentId;
        while (p && byId.has(p)) {
          d++;
          p = byId.get(p)!.parentId;
        }
        return d;
      };
      const ordered = [...sectionNodes].sort((a, b) => depth(b) - depth(a));
      await bulk(ordered.map((nd) => ({ op: "delete", id: nd.id })));
      await ws.refresh();
    } catch (err) {
      console.error("[section] bulk delete failed", err);
    } finally {
      setBusy(false);
    }
  }, [sectionNodes, bulk, ws]);

  /* =================================================================== */
  /* Render                                                              */
  /* =================================================================== */

  // Header title. `node.content` is the BOARD's name (set when the section was
  // bound); `data.name` is the section's OWN name, optional. With a name set it
  // takes the title slot and the board name trails it inline, dimmed and regular
  // weight — so the header reads "what this section is · which board it's on".
  const boardName = node.content.trim();
  const sectionName = ((node.data?.name as string | undefined) ?? "").trim();

  return (
    <div
      ref={boxRef}
      // Content-driven height: the card sizes to its outline/task cards (grows and
      // shrinks), and `onResize` mirrors that into stored `node.height`. `minHeight`
      // (not `node.height`) is the floor, which is what lets it shrink back down.
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: "auto",
        minHeight: MIN_SECTION_HEIGHT,
        // Glide to new positions when the move came from someone else.
        transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
        // A peer editing this section's outline gets a ring in their color.
        outline: remoteEditor ? `2px solid ${remoteEditor.color}` : undefined,
        outlineOffset: 2,
      }}
      className={[
        "group/section flex flex-col overflow-hidden rounded-xl border-2 shadow-sm",
        // A system lane reads as a tray, not a workspace: dashed edge and a muted
        // fill, so parked cards are visibly not being worked on.
        systemKind ? "border-dashed bg-surface-2/70" : "bg-surface",
        selected ? "border-accent" : systemKind ? "border-border" : "border-border-strong",
      ].join(" ")}
    >
      {/* Header = title chip + drag handle + edit affordance */}
      <div
        onPointerDown={onPointerDown}
        className="flex shrink-0 cursor-grab items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 active:cursor-grabbing"
      >
        {(() => {
          const Glyph = systemKind ? TRAY_GLYPH[systemKind].icon : Rows3;
          return (
            <span
              aria-hidden
              className="text-faint"
              title={systemKind ? TRAY_GLYPH[systemKind].hint : undefined}
            >
              <Glyph size={13} strokeWidth={1.75} />
            </span>
          );
        })()}
        {/* Master marker — a STATE, not a control: a section is its board's
            master because it sits in the starred THIS WEEK group, so it's set by
            starring the group, not by clicking here. */}
        {isMaster ? (
          <span
            className="shrink-0 text-accent"
            title="Master section — this board's Send target, because it's in the THIS WEEK group"
          >
            <Star aria-hidden size={13} strokeWidth={2} className="fill-current" />
          </span>
        ) : null}
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onFocus={(e) => e.currentTarget.select()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              // Keep section shortcuts / canvas keys out of the field. Enter and
              // Escape both leave via blur — commit lives in onBlur alone, so it
              // can never run twice for one edit.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRenameRef.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={() => commitName(nameDraft)}
            placeholder="Section name…"
            className="min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 text-sm font-semibold text-fg outline-none placeholder:font-normal placeholder:text-faint"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
            title={
              sectionName
                ? `${sectionName} — on board “${boardName}”. Double-click to rename.`
                : "Double-click to give this section its own name"
            }
            className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
          >
            <span className="min-w-0 break-words text-sm font-semibold text-fg">
              {sectionName || boardName || "Untitled section"}
            </span>
            {sectionName && boardName ? (
              <span className="min-w-0 truncate text-sm font-normal text-fg opacity-[0.84]">
                {boardName}
              </span>
            ) : null}
          </span>
        )}
        {saving || busy ? (
          <span
            aria-label="Saving"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-faint border-t-transparent"
          />
        ) : null}
        {remoteEditor ? (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: remoteEditor.color }}
            title={`${remoteEditor.name} is editing this section`}
          >
            <span className="inline-flex items-center gap-1">
              <Pencil aria-hidden size={10} strokeWidth={2} />
              {remoteEditor.name}
            </span>
          </span>
        ) : null}
        {/* Send-to-master: shown on sections that have a master on the same
            board — `masterSection` is already null when THIS is the master.
            Hover-revealed, like the canvas-index card's close button. Never on a system
            tray: sending deletes the source section, and the reconciler would
            just rebuild it. */}
        {boardId && !systemKind && masterSection ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void sendToMaster();
            }}
            title={`Send all cards to the top of “${masterSection.name}” and delete this section`}
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-faint opacity-0 transition-colors hover:border-accent hover:text-accent group-hover/section:opacity-100"
          >
            <span className="inline-flex items-center gap-1">
              <ArrowUpToLine aria-hidden size={11} strokeWidth={2} />
              Send to {masterSection.name}
            </span>
          </button>
        ) : null}
        {/* Description height: text-mode-only. Caps descriptions at 6 rows or
            lets them grow unbounded (session-only preference). */}
        {boardId && mode === "authoring" ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setDescExpanded((v) => !v);
            }}
            title={
              descExpanded
                ? "Descriptions: showing all — click to cap at 6 rows"
                : "Descriptions: capped at 6 rows — click to show all"
            }
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-faint hover:border-accent hover:text-accent"
          >
            <span className="inline-flex items-center gap-1">
              <ChevronsUpDown aria-hidden size={11} strokeWidth={2} />
              {descExpanded ? "All" : "6"}
            </span>
          </button>
        ) : null}
        {/* Bulk actions on every card in the section. Only when there ARE cards,
            so it's never a dead control. */}
        {(boardId || systemKind) && sectionNodes.length ? (
          <BulkMenu
            count={sectionNodes.length}
            doneCount={sectionNodes.filter((nd) => nd.status === "done").length}
            currentPlacement={systemKind}
            onMoveTo={bulkMoveTo}
            onArchiveDone={bulkArchiveDone}
            onDoneAndArchive={bulkDoneAndArchive}
            onDelete={bulkDelete}
          />
        ) : null}
        {boardId || systemKind ? (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
          >
            {/* No longer gated on `locked`. An outline row is one task FIELD, so
                peers editing different rows commute — several people can sit in
                text mode together and the presence ring/caret is decoration, not
                a permission. (It was a lock only because saving used to diff the
                whole row list; see useOutlineDraft.) */}
            <ViewToggleBtn
              active={mode === "authoring"}
              onClick={() => mode !== "authoring" && enterAuthoring()}
              title={
                remoteEditor ? `${remoteEditor.name} is in here too — Outline` : "Outline"
              }
            >
              <AlignJustify aria-hidden size={14} strokeWidth={1.75} />
            </ViewToggleBtn>
            <ViewToggleBtn
              active={viewMode === "committed"}
              onClick={() => {
                if (mode === "committed") return;
                void flush();
                setMode("committed");
              }}
              title="Cards"
            >
              <LayoutGrid aria-hidden size={14} strokeWidth={1.75} />
            </ViewToggleBtn>
          </div>
        ) : null}
      </div>

      {/* Body — interior stops canvas panning/selection so it stays interactive
          (pointer for pan/marquee). Grows with its content (no internal scroll):
          the whole card follows via the ResizeObserver above. `flex-1`/`min-h-0`
          let the body fill the card down to MIN_SECTION_HEIGHT when content is
          short, so the empty-state `h-full` still centers. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="min-h-0 flex-1 overflow-hidden p-2"
      >
        {viewMode === "naming" ? (
          isCreator ? (
            <NameBinder onBind={bindBoard} />
          ) : (
            <PendingSetup who={creatorName} />
          )
        ) : viewMode === "authoring" ? (
          <OutlineEditor
            rows={rows}
            inputRefs={inputRefs}
            descCapped={!descExpanded}
            onText={setText}
            onKeyDown={onRowKeyDown}
            peers={peerFields}
            onCaret={publishCaret}
            lockFor={lockFor}
            onTakeOver={takeOver}
            yieldedTo={yieldedTo}
            takingField={taking?.field ?? null}
            changedField={changedField}
          />
        ) : (
          <CommittedList
            units={visibleUnits}
            filter={filter}
            onOpen={ws.openTask}
            onToggle={ws.toggleDone}
            onStatus={ws.setStatus}
            onAssign={ws.editTask}
            onImportance={(id, v) => ws.editTask(id, { importance: v })}
            onMove={ws.moveNode}
            onAddTask={(title, assigneeIds) =>
              ws.addSectionTask({
                title,
                canvasSectionId: pin,
                boardId,
                parentId: null,
                siblingIds,
                assigneeIds,
              })
            }
            // Same create, but landing above the card whose gap was clicked. The
            // run goes with it: these are the rows this section actually draws at
            // top level (`units`, not the assignee-filtered view — a hidden card is
            // still in the order being restamped).
            onAddTaskAbove={(beforeId, title, assigneeIds) =>
              ws.addSectionTask({
                title,
                canvasSectionId: pin,
                boardId,
                parentId: null,
                siblingIds,
                insertBefore: beforeId,
                runIds: rootIds,
                assigneeIds,
              })
            }
            // Subtasks are never pinned — they inherit their parent's placement,
            // so they follow it if the parent is dragged elsewhere.
            onAddSubtask={(parentId, title, assigneeIds) =>
              ws.addSectionTask({
                title,
                canvasSectionId: null,
                boardId,
                parentId,
                assigneeIds,
              })
            }
            onDropIntoSection={(dragId) =>
              ws.moveNodeIntoSection(dragId, pin, boardId, { siblingIds })
            }
          />
        )}
      </div>
    </div>
  );
}

/** Destinations the "Move to…" list offers, in the order it offers them: THIS
 *  WEEK first because it's where a sweep almost always goes (and the one the
 *  canvas already draws in orange), then the rest of the ladder. */
const MOVE_TO_ORDER: readonly TaskPlacement[] = [
  "today",
  "thisWeek",
  "backlog",
  "later",
  "inbox",
  "doneThisWeek",
];

/**
 * "Bulk" header menu — actions that sweep EVERY card in the section at once.
 * Portaled (via AnchoredPopover) because the section card and the canvas root are
 * both `overflow-hidden`, which would clip an in-flow dropdown.
 *
 * Two views in the one popover: the action list, and the "Move to…" destination
 * list it swaps to (with a back row). A submenu that flew out sideways would need
 * its own flipping logic against the canvas edge; swapping in place doesn't.
 */
function BulkMenu({
  count,
  doneCount,
  currentPlacement,
  onMoveTo,
  onArchiveDone,
  onDoneAndArchive,
  onDelete,
}: {
  count: number;
  doneCount: number;
  /** The group this section IS, when it's a machine-managed tray — dropped from
   *  the destination list, since moving cards to where they already are is a
   *  no-op write. Null on an ordinary section. */
  currentPlacement: SystemGroup | null;
  onMoveTo: (to: TaskPlacement) => void | Promise<void>;
  onArchiveDone: () => void | Promise<void>;
  onDoneAndArchive: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"actions" | "move">("actions");

  const close = () => {
    setOpen(false);
    setView("actions"); // always reopen on the action list
  };

  const item = (
    label: string,
    danger: boolean,
    run: () => void | Promise<void>,
    opts: { disabled?: boolean; trailing?: string } = {},
  ) => (
    <button
      type="button"
      disabled={opts.disabled}
      onClick={() => {
        close(); // close first — the actions confirm() synchronously
        void run();
      }}
      className={[
        "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs",
        opts.disabled
          ? "cursor-not-allowed text-faint opacity-60"
          : ["hover:bg-surface-2", danger ? "text-red-600" : "text-fg"].join(" "),
      ].join(" ")}
    >
      <span>{label}</span>
      {opts.trailing ? <span className="text-[10px] text-faint">{opts.trailing}</span> : null}
    </button>
  );

  const destinations = MOVE_TO_ORDER.filter((to) => to !== currentPlacement);

  return (
    <div ref={rootRef} className="shrink-0" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        title={`Bulk actions on all ${count} card${count === 1 ? "" : "s"} in this section`}
        className={[
          "rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
          open ? "border-accent text-accent" : "border-border text-faint hover:border-accent hover:text-accent",
        ].join(" ")}
      >
        Bulk
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={close}
        align="right"
        className="w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-faint">
          {view === "move" ? "Move to" : `${count} card${count === 1 ? "" : "s"}`}
        </p>
        {view === "actions" ? (
          <>
            {/* Opens the destination list in place — no confirm, so it doesn't go
                through `item`'s close-then-run. */}
            <button
              type="button"
              onClick={() => setView("move")}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-surface-2"
            >
              <span>Move to…</span>
              <ChevronRight aria-hidden size={12} strokeWidth={2} className="text-faint" />
            </button>
            {item("Archive done tasks", false, onArchiveDone, {
              disabled: doneCount === 0,
              trailing: doneCount ? String(doneCount) : "none done",
            })}
            {item("Done and archive", false, onDoneAndArchive)}
            {item("Delete", true, onDelete)}
          </>
        ) : (
          <>
            {destinations.map((to) => {
              const week = to === "thisWeek";
              const Glyph = TRAY_GLYPH[to].icon;
              return (
                <button
                  key={to}
                  type="button"
                  onClick={() => {
                    close();
                    void onMoveTo(to);
                  }}
                  // THIS WEEK carries the same orange the canvas draws its tray
                  // hull in — it's the row you work out of, so it reads first.
                  style={week ? { color: "var(--color-orange)" } : undefined}
                  className={[
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-2",
                    week ? "font-semibold" : "text-fg",
                  ].join(" ")}
                >
                  <span aria-hidden className={week ? undefined : "text-faint"}>
                    <Glyph size={13} strokeWidth={week ? 2 : 1.75} />
                  </span>
                  <span>{PLACEMENT_TITLE[to]}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setView("actions")}
              className="mt-0.5 flex w-full items-center gap-2 rounded border-t border-border px-2 py-1.5 pt-2 text-left text-xs text-faint hover:bg-surface-2"
            >
              <ChevronLeft aria-hidden size={12} strokeWidth={2} />
              <span>Back</span>
            </button>
          </>
        )}
      </AnchoredPopover>
    </div>
  );
}

/** Segmented view-switch button in the section header (Outline ⇄ Cards). */
function ViewToggleBtn({
  active,
  onClick,
  title,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={title}
      className={[
        "grid h-5 w-5 place-items-center rounded text-xs transition-colors",
        active ? "bg-accent-soft text-accent" : "text-faint hover:text-fg",
        disabled ? "cursor-not-allowed opacity-40" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* ---------------- naming ---------------- */

/** What peers see while the section's creator is still choosing its board. The
 *  board-picker is private to the creator; this flips to the committed section
 *  automatically once the creator binds a board (see the boardId effect). */
function PendingSetup({ who }: { who: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-faint">
      {who} is setting up this section…
    </div>
  );
}

function NameBinder({
  onBind,
}: {
  onBind: (boardId: string, name: string) => void;
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Pick an EXISTING board — the section attaches to it (that's where its tasks
  // live and how they show up in the board view). It does NOT pull in the
  // board's current tasks: a section only shows the tasks you add to it, scoped
  // by its own hidden section id. Several sections can point at one board.
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = ws.projects.flatMap((p) =>
      (p.boards ?? []).map((b) => ({ id: b.id, name: b.name, project: p.name })),
    );
    if (!needle) return all.slice(0, 8);
    return all.filter((b) => b.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [q, ws.projects]);

  // Keep the highlighted row scrolled into view during arrow navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="space-y-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0); // filtering reflows the list — re-highlight the top
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            const b = matches[active];
            if (b) onBind(b.id, b.name);
          }
        }}
        placeholder="Which board is this section on?"
        className="w-full rounded-md border border-accent bg-surface px-2 py-1 text-sm text-fg outline-none"
      />
      <div
        ref={listRef}
        className="max-h-48 overflow-y-auto rounded-md border border-border"
      >
        {matches.length === 0 ? (
          <p className="px-2 py-2 text-xs text-faint">
            No boards match. Create the board first, then attach a section to it.
          </p>
        ) : (
          matches.map((b, i) => (
            <button
              key={b.id}
              data-idx={i}
              onMouseEnter={() => setActive(i)}
              onClick={() => onBind(b.id, b.name)}
              className={[
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
                i === active ? "bg-surface-2" : "",
              ].join(" ")}
            >
              <span className="truncate text-fg">{b.name}</span>
              <span className="ml-auto shrink-0 truncate text-[11px] text-faint">{b.project}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- authoring ---------------- */

/** A textarea that auto-sizes to its content. When `capped`, it grows to at
 *  most 6 rows and scrolls the overflow; otherwise it grows unbounded. Used for
 *  both title rows (never capped — they just wrap) and description rows. Its
 *  inner textarea is forwarded to `registerRef` so the outline's inputRefs map
 *  and caret-restore effect keep working. */
/* ---------------- committed ---------------- */

/**
 * The actions a card can take — CALLBACKS ONLY, and held in one object whose
 * identity never changes for the life of a list (see `CommittedList`).
 *
 * Nothing that a card renders FROM belongs in here. It used to carry the whole
 * `taskMap` and the list's current drop hint, which meant the bag changed
 * identity on every task change and every dragover, so `memo(TaskCard)` could
 * never bail out and one edit re-rendered every card on the canvas (TD-132).
 * A card now reads its own task off `unit.task` and owns its own drop hint.
 */
interface CardHandlers {
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onImportance: (id: string, v: Importance) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  /** Create a subtask under this task (from the hover "+ Subtask" button). */
  onAddSubtask: (parentId: string, title: string, assigneeIds?: string[]) => void;
}

interface TaskCardProps {
  unit: TaskUnit;
  depth: number;
  /** The filter in force (TD-59/TD2-216) — a card that doesn't itself match is
   *  dimmed, since it's drawn only as context for a matching descendant (see
   *  `filterUnits`). A prop rather than part of `h` because the card RENDERS
   *  from it, so memo has to compare it. */
  filter: RenderFilter;
  h: CardHandlers;
}

/** One task card + its children, rendered recursively (arbitrary depth).
 *
 *  Memoized (see the export at the bottom of this component): every prop is
 *  either a primitive, the stable `h`, or a `unit` whose identity `useSectionUnits`
 *  keeps stable across rebuilds — so a change to ONE task re-renders one card
 *  instead of all of them. */
function TaskCardInner({ unit, depth, filter, h }: TaskCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [addingSub, setAddingSub] = useState(false);
  // Which edge a hovered drop would land on. Card-local — as a single hint on the
  // list it re-rendered every sibling on every dragover. Same shape as the kanban
  // card's own `dropPos`.
  const [hint, setHint] = useState<"before" | "after" | null>(null);
  // The card clears its own hint on drop, but not on an Escape-cancelled drag —
  // nothing fires on it then. Same session-end rule as the section's ring.
  useDragSessionEnd(hint !== null, () => setHint(null));
  const id = unit.taskId;
  const t = unit.task;
  const done = t?.status === "done";
  // The hover keyboard set — D · 1/2 · SPACE · DELETE · ↑→↓ — from the one shared
  // definition every task card uses. It's hover-scoped and fires in capture, so
  // it beats the canvas editor's own single-key tools, its Delete (which removes
  // selected NODES), its space-to-pan and its arrow-nudge. The tray is resolved
  // from this canvas's own nodes, so nothing needs passing in here.
  useTaskCardShortcuts(cardRef, id);
  if (!id || !t) return null;
  const ic = IMPORTANCE_CARD[t.importance ?? 0];
  // Status ring + corner badge — canvas only, and only for "started" statuses
  // (analyzing/analyzed/building/review). Backlog/todo/done are absent from the
  // map, so they get no ring/badge (done keeps its green wash below).
  const badge = STATUS_CANVAS_BADGE[t.status];
  const statusTone = STATUS_TONE[t.status];

  // Filtered-in only as context for a matching descendant (TD-59) — dim it so
  // the actual match still reads as the point of the filter.
  const dimmedByFilter = filter.active && !filter.keep(t);
  const half = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  return (
    <div style={{ marginLeft: depth ? 12 : 0 }}>
      <div
        ref={cardRef}
        data-card
        data-task-id={id}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(SECTION_DND_MIME, id);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SECTION_DND_MIME)) return;
          e.preventDefault();
          e.stopPropagation(); // over a card → not the section's blank-area zone
          setHint(half(e));
        }}
        onDragLeave={(e) => {
          // Ignore leaves into a child element — dragging across a control inside
          // the card fires dragleave on the way past, and reacting makes the line
          // flicker.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint(null);
        }}
        onDrop={(e) => {
          e.stopPropagation(); // a card handled it — don't also fire the body zone
          const dragId = e.dataTransfer.getData(SECTION_DND_MIME);
          const pos = half(e);
          setHint(null);
          if (dragId && dragId !== id) h.onMove(dragId, id, pos);
        }}
        // The whole card is the open target (not just the title). Interactive
        // children — QuickStatus/QuickAssign triggers, the title button — stop
        // their own clicks from bubbling here, so they don't also open the task.
        onClick={() => h.onOpen(id)}
        className={[
          "group/card relative cursor-pointer rounded-lg border px-2 py-1.5 transition-colors",
          done
            ? "border-buff/40 bg-buff-soft hover:border-buff/60"
            : `${ic.border} ${ic.bg} ${ic.hover}`,
          // Status ring (outline, not ring — avoids clashing with the drop-hint
          // box-shadow below). Follows the rounded corners.
          badge ? `outline outline-[3px] outline-offset-2 ${statusTone.outline}` : "",
          hint === "before" ? "shadow-[inset_0_2px_0_0_var(--color-accent)]" : "",
          hint === "after" ? "shadow-[inset_0_-2px_0_0_var(--color-accent)]" : "",
          dimmedByFilter ? "opacity-45" : "",
        ].join(" ")}
      >
        {badge ? (
          <span
            className={`absolute -top-2 right-2 z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${statusTone.dot}`}
          >
            {badge}
          </span>
        ) : null}
        {/* Hover-revealed "+ Subtask" — top-right, below any status badge. Opens
            the nested composer under this card. */}
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setAddingSub(true);
          }}
          title="Add subtask"
          className={[
            "absolute right-1.5 z-20 hidden items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted shadow-sm hover:border-accent hover:text-accent group-hover/card:flex",
            badge ? "top-3" : "top-1.5",
          ].join(" ")}
        >
          <span className="leading-none">+</span> Subtask
        </button>
        <TaskCardBody task={t} h={h} />
      </div>
      {unit.children.length || addingSub ? (
        <div className="mt-1.5 space-y-1.5">
          {unit.children.map((c) => (
            <TaskCard
              key={c.taskId ?? c.title}
              unit={c}
              depth={depth + 1}
              filter={filter}
              h={h}
            />
          ))}
          {addingSub ? (
            <div style={{ marginLeft: 12 }}>
              <InlineTaskComposer
                label="Subtask"
                assigneeId={filter.assigneeId}
                onSubmit={(title, assigneeIds) =>
                  h.onAddSubtask(id, title, assigneeIds)
                }
                onClose={() => setAddingSub(false)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Does this unit describe the same thing as that one? Compares TASK IDENTITY
 *  rather than fields: `taskMap` entries are replaced only when that task
 *  actually changes, so one reference check settles a card's whole content.
 *  Recurses because a card renders its own descendants. */
const sameUnit = (a: TaskUnit, b: TaskUnit): boolean =>
  a.taskId === b.taskId &&
  a.task === b.task &&
  a.children.length === b.children.length &&
  a.children.every((c, i) => sameUnit(c, b.children[i]));

/**
 * The memo boundary that makes a big canvas cheap (TD-132).
 *
 * `useSectionUnits` allocates a fresh unit tree on every rebuild, so the default
 * shallow compare would never match — hence the structural `sameUnit` on that one
 * prop. Everything else is a primitive or the stable `h`, so a change to ONE task
 * re-renders ONE card instead of every card on the canvas.
 */
const TaskCard = memo(
  TaskCardInner,
  (prev, next) =>
    prev.depth === next.depth &&
    prev.filter === next.filter &&
    prev.h === next.h &&
    sameUnit(prev.unit, next.unit),
);

/**
 * Inline task/subtask composer — the "+ Add task" / "+ Subtask" input. Mirrors
 * the kanban AddCard UX: Enter creates and CLEARS but keeps the input open for
 * rapid entry; Esc or an empty blur closes it.
 *
 * Two modes: self-managed (no `onClose`) toggles its own button ↔ input, used
 * for the always-present bottom composer; controlled-open (`onClose` given) is
 * mounted already editing by its parent, and closing calls `onClose` to unmount
 * — used for the per-card subtask composer.
 */
function InlineTaskComposer({
  label,
  onSubmit,
  onClose,
  assigneeId = null,
}: {
  label: string;
  onSubmit: (title: string, assigneeIds?: string[]) => void;
  onClose?: () => void;
  /** The assignee filter in force — see `useAssignOnCreate` (TD2-193). Without
   *  it, a card typed into a filtered section vanishes as it is created. */
  assigneeId?: string | null;
}) {
  const controlled = !!onClose;
  const [editing, setEditing] = useState(controlled);
  const [text, setText] = useState("");
  const assign = useAssignOnCreate(assigneeId);

  const close = () => {
    setText("");
    if (controlled) onClose?.();
    else setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-faint hover:bg-surface-3 hover:text-muted"
      >
        <span className="text-sm leading-none">+</span> {label}
      </button>
    );
  }

  return (
    <div onPointerDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && text.trim()) {
            onSubmit(text.trim(), assign.assigneeIds);
            setText(""); // keep open for rapid entry
          } else if (e.key === "Escape") {
            close();
          }
        }}
        onBlur={() => {
          if (!text.trim()) close();
        }}
        placeholder={`${label} name, then Enter…`}
        className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
      />
      {assign.control}
    </div>
  );
}

/**
 * The clickable gap BETWEEN two cards — how a task gets added mid-list instead of
 * only at the end.
 *
 * Zero-height with an absolutely-positioned hit strip over the gap, so it costs
 * no layout and can't push the cards apart. Idle it's invisible; hovered it draws
 * the line and a "+ Add task here" pill where the new card will land — the pill
 * has its own hover state, so the thing under the cursor is clearly the button
 * (the whole strip is clickable, not just the pill). Click or double-click both
 * open the composer — the gesture people reach for first is the double-click, but
 * a single click in a 6px band is no less deliberate.
 *
 * Drags are deliberately NOT handled here: a card dropped on the strip falls
 * through to the section's own blank-area zone, which is what a drop outside a
 * card already means.
 */
function InsertGap({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="relative h-0">
      <button
        type="button"
        title="Add a task here"
        aria-label="Add a task here"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="group/gap absolute inset-x-0 -top-2 z-10 h-4 cursor-pointer"
      >
        <span className="absolute inset-x-1 top-1/2 hidden h-px -translate-y-1/2 bg-accent/50 group-hover/gap:block" />
        <span className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 whitespace-nowrap rounded border border-accent/40 bg-surface px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent shadow-sm transition-colors group-hover/gap:flex hover:border-accent hover:bg-accent hover:text-white">
          + Add task here
        </span>
      </button>
    </div>
  );
}

function CommittedList({
  units,
  filter,
  onOpen,
  onToggle,
  onStatus,
  onAssign,
  onImportance,
  onMove,
  onAddTask,
  onAddTaskAbove,
  onAddSubtask,
  onDropIntoSection,
}: {
  units: TaskUnit[];
  /** TD-59/TD2-216: dims a card kept only as context for a matching descendant. */
  filter: RenderFilter;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onImportance: (id: string, v: Importance) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  onAddTask: (title: string, assigneeIds?: string[]) => void;
  /** Create a card immediately ABOVE this one (the between-cards composer). */
  onAddTaskAbove: (beforeTaskId: string, title: string, assigneeIds?: string[]) => void;
  onAddSubtask: (parentId: string, title: string, assigneeIds?: string[]) => void;
  /** Drop a card into THIS section's blank area (or an empty section) — lands it
   *  at the end as a top-level card, moving it (and its subtree) here. */
  onDropIntoSection: (dragId: string) => void;
}) {
  // True while a section-task drag hovers the list's blank area (not a card) —
  // draws a dashed ring so it reads as "drop here to move into this section".
  const [overSection, setOverSection] = useState(false);
  // ...and the ring goes out when the drag does. Dropping ON a card leaves the
  // handlers below no chance to clear it themselves — see `useDragSessionEnd`.
  useDragSessionEnd(overSection, () => setOverSection(false));
  // Which card the between-cards composer is currently open ABOVE (one at a time).
  const [insertAbove, setInsertAbove] = useState<string | null>(null);

  /* ONE handler bag with ONE identity for the life of the list — the memo
   * boundary on `TaskCard` rests on it. Each entry is wrapped so its identity
   * holds while still calling the current closure: these arrive off the workspace
   * context, which rebuilds them every render, so passing them straight down made
   * every card re-render on every task change (TD-132). */
  const sOpen = useEventCallback(onOpen);
  const sToggle = useEventCallback(onToggle);
  const sStatus = useEventCallback(onStatus);
  const sAssign = useEventCallback(onAssign);
  const sImportance = useEventCallback(onImportance);
  const sMove = useEventCallback(onMove);
  const sAddSubtask = useEventCallback(onAddSubtask);
  const h = useMemo<CardHandlers>(
    () => ({
      onOpen: sOpen,
      onToggle: sToggle,
      onStatus: sStatus,
      onAssign: sAssign,
      onImportance: sImportance,
      onMove: sMove,
      onAddSubtask: sAddSubtask,
    }),
    [sOpen, sToggle, sStatus, sAssign, sImportance, sMove, sAddSubtask],
  );
  return (
    <div
      // Section-level drop zone. Card drops stopPropagation, so this fires only
      // for drops on the blank area — appending the dragged subtree here. Works
      // for empty sections too (no cards to target).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SECTION_DND_MIME)) return;
        e.preventDefault();
        setOverSection(true);
      }}
      onDragLeave={(e) => {
        // Ignore leaves into child elements — only clear when truly exiting.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOverSection(false);
      }}
      onDrop={(e) => {
        setOverSection(false);
        const dragId = e.dataTransfer.getData(SECTION_DND_MIME);
        if (dragId) onDropIntoSection(dragId);
      }}
      className={[
        "min-h-16 space-y-1.5 rounded-lg transition-colors",
        overSection ? "outline-dashed outline-2 outline-offset-2 outline-accent/60" : "",
      ].join(" ")}
    >
      {units.map((u) => (
        <Fragment key={u.taskId ?? u.title}>
          {/* One insertion point above each card — so the top of the list and
              every gap between two cards can take a new task. Below the last one
              is what the bottom composer already is. */}
          {u.taskId ? (
            insertAbove === u.taskId ? (
              <InlineTaskComposer
                label="Task"
                assigneeId={filter.assigneeId}
                onSubmit={(title, assigneeIds) =>
                  onAddTaskAbove(u.taskId!, title, assigneeIds)
                }
                onClose={() => setInsertAbove(null)}
              />
            ) : (
              <InsertGap onOpen={() => setInsertAbove(u.taskId)} />
            )
          ) : null}
          <TaskCard unit={u} depth={0} filter={filter} h={h} />
        </Fragment>
      ))}
      {/* Always-present "+ Add task" composer at the bottom of the list. */}
      <InlineTaskComposer
        label="Add task"
        assigneeId={filter.assigneeId}
        onSubmit={onAddTask}
      />
    </div>
  );
}
