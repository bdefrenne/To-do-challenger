/**
 * Outline model for canvas Sections — the pure logic behind the two-mode
 * editor. A Section's authoring surface is a flat list of `OutlineRow`s. Each
 * row is either a TASK at some `indent` depth (0 = top level, 1 = subtask, 2 =
 * sub-subtask, …) or a `desc` — a multiline description block belonging to the
 * nearest task above it. Task rows carry a bound `taskId` so re-editing patches
 * the same task instead of duplicating it.
 *
 * Which key does what lives in SectionNode; what a key DOES to the rows lives
 * here, alongside the rows ⇄ tree conversion and the op payloads a row edit
 * produces. This file is UI-free and side-effect-free so it's easy to test —
 * everything that needs a room, a socket or a DOM stays in `useOutlineDraft`.
 *
 * **Changing anything here? Run `npm run check:outline`.** These rules decide
 * whether a task is created, deleted, or has someone's caret ripped out of it, and
 * the merge below has been rewritten five times — the suite is what stops each fix
 * reintroducing an earlier bug.
 */

import type { Task } from "./types";

/** One line in a Section's outline. */
export interface OutlineRow {
  key: string;
  /** Bound task (null = not yet created). Always null for `desc` rows. */
  taskId: string | null;
  /** Nesting depth for task rows; display depth for a desc row (owner + 1). */
  indent: number;
  /** True = a (possibly multiline) description of the nearest task above. */
  desc: boolean;
  text: string;
}

/** A task with its description and children — the committed tree shape. */
export interface TaskUnit {
  taskId: string | null;
  title: string;
  description: string;
  children: TaskUnit[];
  /** The live task this unit stands for, when the tree was built FROM tasks
   *  (`useSectionUnits`) rather than from editor text. Carried on the unit so a
   *  card can render itself without being handed the whole `taskMap` — which is
   *  what lets a card memoize past a change to some other task (TD-132). Absent
   *  for units `rowsToUnits` invents from a line the user just typed. */
  task?: Task;
  /** The editor row this unit came from (set by rowsToUnits) — lets the caller
   *  write a freshly-created task id back onto that row so the next autosave
   *  updates it instead of creating a duplicate. Absent for the live tree. */
  rowKey?: string;
}

const newKey = () => crypto.randomUUID();

/** A fresh empty row. */
export function newRow(indent = 0, desc = false, text = ""): OutlineRow {
  return { key: newKey(), taskId: null, indent, desc, text };
}

/** Group a flat row list into a task tree. A task row nests under the nearest
 *  task at a shallower depth (indent is clamped so you can't skip levels). A
 *  desc row folds into the deepest current task. Tolerant of orphans and empty
 *  rows: an empty task row is dropped (so its id, if any, won't survive → gets
 *  deleted), and a desc with no task above is promoted to a task. */
export function rowsToUnits(rows: OutlineRow[]): TaskUnit[] {
  const roots: TaskUnit[] = [];
  const stack: TaskUnit[] = []; // stack[d] = the current task at depth d
  const pushDesc = (t: TaskUnit, text: string) => {
    t.description = t.description ? `${t.description}\n${text}` : text;
  };

  for (const row of rows) {
    if (row.desc) {
      const body = row.text.trim();
      if (!body) continue;
      const owner = stack[stack.length - 1];
      if (owner) {
        pushDesc(owner, body);
      } else {
        const u: TaskUnit = { taskId: null, title: body, description: "", children: [] };
        roots.push(u);
        stack.length = 0;
        stack[0] = u;
      }
      continue;
    }

    const title = row.text.trim();
    if (!title) continue; // blank task row → dropped (its id won't survive → delete)

    const depth = Math.min(row.indent, stack.length); // clamp: no skipping levels
    const unit: TaskUnit = { taskId: row.taskId, title, description: "", children: [], rowKey: row.key };
    if (depth > 0 && stack[depth - 1]) stack[depth - 1].children.push(unit);
    else roots.push(unit);
    stack.length = depth;
    stack[depth] = unit;
  }

  return roots;
}

/** Seed the authoring editor from a task tree — the inverse of rowsToUnits.
 *  Each task becomes a row at its depth; its description (if any) becomes one
 *  multiline desc row just below it; children recurse one level deeper. */
export function unitsToRows(units: TaskUnit[]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (u: TaskUnit, depth: number) => {
    rows.push({ key: newKey(), taskId: u.taskId, indent: depth, desc: false, text: u.title });
    if (u.description.trim()) {
      rows.push({ key: newKey(), taskId: null, indent: depth + 1, desc: true, text: u.description });
    }
    for (const c of u.children) walk(c, depth + 1);
  };
  for (const u of units) walk(u, 0);
  return rows;
}

/** Every task id in the tree (top-level + all descendants). Used to compute
 *  which existing section tasks were removed and should be deleted. */
export function survivingIds(units: TaskUnit[]): Set<string> {
  const ids = new Set<string>();
  const walk = (u: TaskUnit) => {
    if (u.taskId) ids.add(u.taskId);
    u.children.forEach(walk);
  };
  units.forEach(walk);
  return ids;
}

/** Flatten a tree into depth-ordered entries with parent + sibling index, for
 *  committing level-by-level (parents created before children). */
export function flattenUnits(
  units: TaskUnit[],
): { unit: TaskUnit; parent: TaskUnit | null; depth: number; index: number }[] {
  const out: { unit: TaskUnit; parent: TaskUnit | null; depth: number; index: number }[] = [];
  const walk = (list: TaskUnit[], parent: TaskUnit | null, depth: number) => {
    list.forEach((unit, index) => {
      out.push({ unit, parent, depth, index });
      walk(unit.children, unit, depth + 1);
    });
  };
  walk(units, null, 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * Op helpers — what a single row edit means for the tasks table.
 *
 * The outline used to persist by DIFFING the whole row list against the DB
 * (dense-position reassert per sibling group, deletes inferred from a missing
 * id). That is only safe for one author: two people saving their own whole list
 * revert each other. These helpers let a save express ONE row's change instead
 * — which parent it hangs off, which field it writes, and a fractional position
 * between its neighbours — so concurrent edits to different rows commute.
 * Pure and row-local, so they're testable without a room or a database.
 * ------------------------------------------------------------------ */

/** The task row `index` nests under: the nearest earlier task row shallower than
 *  it. Null at top level. (Desc rows are skipped — they aren't tasks.) */
export function parentRowAt(rows: OutlineRow[], index: number): OutlineRow | null {
  const row = rows[index];
  if (!row) return null;
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.desc) continue;
    if (r.indent < row.indent) return r;
  }
  return null;
}

/** The task row a DESCRIPTION row belongs to: the nearest task row above it.
 *  Mirrors `rowsToUnits`, which folds a desc into the deepest current task. */
export function descOwnerAt(rows: OutlineRow[], index: number): OutlineRow | null {
  for (let i = index - 1; i >= 0; i--) if (!rows[i].desc) return rows[i];
  return null;
}

/** The `description` value a task actually gets, folded from EVERY desc row
 *  under it — the field one desc row writes. `rowsToUnits` joins them with a
 *  newline, so a save must send the same fold or it would drop the siblings.
 *  This is also why two people on two lines of one description block are on ONE
 *  field, and therefore last-writer-wins. */
export function foldedDescriptionFor(rows: OutlineRow[], ownerIndex: number): string {
  const parts: string[] = [];
  for (let i = ownerIndex + 1; i < rows.length; i++) {
    if (!rows[i].desc) break; // the next task row ends this task's description
    const body = rows[i].text.trim();
    if (body) parts.push(body);
  }
  return parts.join("\n");
}

/** A fractional sort key for the row at `index`, midway between the DB positions
 *  of its bound siblings — the same midpoint trick the canvas drag uses for drop
 *  slots. `position` is `doublePrecision` (see schema), so inserting between two
 *  rows never has to renumber the group, which is what lets two people insert at
 *  once without fighting over 0,1,2,….
 *
 *  `positionOf` answers with a task's current DB position (undefined if unknown,
 *  e.g. a sibling created moments ago by a peer). */
export function siblingPositionAt(
  rows: OutlineRow[],
  index: number,
  positionOf: (taskId: string) => number | undefined,
): number {
  const row = rows[index];
  if (!row) return 0;
  const parent = parentRowAt(rows, index);
  const sameGroup = (i: number) => {
    const r = rows[i];
    if (r.desc || r.indent !== row.indent) return false;
    const p = parentRowAt(rows, i);
    return (p?.taskId ?? null) === (parent?.taskId ?? null);
  };
  const posAt = (i: number) => {
    const id = rows[i].taskId;
    return id ? positionOf(id) : undefined;
  };

  let before: number | undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (!sameGroup(i)) continue;
    const p = posAt(i);
    if (p !== undefined) {
      before = p;
      break;
    }
  }
  let after: number | undefined;
  for (let i = index + 1; i < rows.length; i++) {
    if (!sameGroup(i)) continue;
    const p = posAt(i);
    if (p !== undefined) {
      after = p;
      break;
    }
  }

  if (before !== undefined && after !== undefined) return (before + after) / 2;
  if (before !== undefined) return before + 1;
  if (after !== undefined) return after - 1;
  return 0;
}

/** The task FIELD a row writes: a title row owns `tasks.title`, a description row
 *  owns its owner's `tasks.description`. This is the identity two clients agree on
 *  — `key` is a local UUID minted at seed time and never matches across browsers.
 *  Null for a row with no task yet. */
export function rowFieldKey(rows: OutlineRow[], index: number): string | null {
  const row = rows[index];
  if (!row) return null;
  if (!row.desc) return row.taskId;
  const owner = descOwnerAt(rows, index);
  return owner?.taskId ? `${owner.taskId}#desc` : null;
}

/** Every row's field key in ONE pass. Per-row `rowFieldKey` is O(N²) — each desc
 *  row walks back for its owner — and this runs on every keystroke. */
export function rowFieldKeys(rows: OutlineRow[]): (string | null)[] {
  let lastTaskId: string | null = null;
  return rows.map((r) => {
    if (!r.desc) {
      lastTaskId = r.taskId;
      return r.taskId;
    }
    return lastTaskId ? `${lastTaskId}#desc` : null;
  });
}

/**
 * Fold a fresh tree from the server into the rows on screen, without disturbing
 * what the user is doing.
 *
 * The outline used to refuse to re-seed at all while its inputs were focused,
 * which meant two people typing in the same list never saw each other — both are
 * always focused. Rebuilding wholesale instead is just as wrong: it changes every
 * row key (remounting every textarea, losing the caret) and it overwrites text
 * that hasn't reached the server yet.
 *
 * So merge per FIELD:
 *   • A row we already have keeps its `key`, so the DOM node — and the caret in
 *     it — survives. Structure (`indent`, order) comes from the server; it is
 *     whoever restructured that owns it.
 *   • A field in `protectedFields` keeps OUR text. That's the row the caret is in,
 *     plus any field typed but not yet confirmed by the server — without the
 *     second, a peer's unrelated edit would revert your own last sentence.
 *   • Rows with no task yet exist only here (their create hasn't landed), so they
 *     are re-inserted after the row they followed rather than dropped.
 */
/** What a preserved row sat between locally: the nearest identifiable field above
 *  it and the nearest one below. `below` is the one that matters — a local row's
 *  real intent is "before that row", and honouring it keeps a trailing composer
 *  trailing while a mid-list line stays mid-list. */
function anchorsFor(
  fields: (string | null)[],
  index: number,
): { above: string | null; below: string | null } {
  let above: string | null = null;
  for (let j = index - 1; j >= 0; j--)
    if (fields[j]) {
      above = fields[j];
      break;
    }
  let below: string | null = null;
  for (let j = index + 1; j < fields.length; j++)
    if (fields[j]) {
      below = fields[j];
      break;
    }
  return { above, below };
}

export function mergeOutlineRows(
  seeded: OutlineRow[],
  current: OutlineRow[],
  protectedFields: ReadonlySet<string>,
  /** The row the caret is in. An EMPTY row with no task is kept only if it is this
   *  one — otherwise every merge preserved the blank trailing row AND added a
   *  fresh one, growing the list by a row per refresh until the section filled
   *  with "task…" placeholders. The merge has to be idempotent. */
  focusedRowKey: string | null = null,
  /** Fields whose task this session has written but has NOT yet seen come back
   *  from the server. A bound row missing from `seeded` is normally a peer's
   *  delete, so it is dropped — but a task created a moment ago is missing for a
   *  quite different reason, and dropping it yanked the row (and the caret) out
   *  from under someone typing a subtask. */
  keepFields: ReadonlySet<string> = new Set(),
): OutlineRow[] {
  const currentKeys = rowFieldKeys(current);
  const seededFields = new Set(rowFieldKeys(seeded).filter((f): f is string => !!f));
  const mine = new Map<string, OutlineRow>();
  currentKeys.forEach((field, i) => {
    if (!field) return;
    // First row for a field wins — EXCEPT the row the caret is in. Two local desc
    // rows can share one field (`X#desc`), and collapsing them onto the first
    // row's key would delete the DOM node the caret was sitting in.
    if (!mine.has(field) || current[i].key === focusedRowKey) mine.set(field, current[i]);
  });

  const merged = seeded.map((row, i) => {
    const field = rowFieldKey(seeded, i);
    const existing = field ? mine.get(field) : undefined;
    if (!existing) return row;
    return {
      ...row,
      key: existing.key, // keep the DOM node, and the caret inside it
      text: field && protectedFields.has(field) ? existing.text : row.text,
    };
  });

  // Local-only rows (typed, no task yet) — anchored to the field above them.
  const pending: { above: string | null; below: string | null; row: OutlineRow }[] = [];
  current.forEach((row, i) => {
    const field = currentKeys[i];
    // Already in the server's copy → the map above handled it.
    if (field && seededFields.has(field)) return;

    // THE INVARIANT, first: never drop the row the caret is in. Whatever the reason
    // the server hasn't got it — a create still in flight, a description that
    // doesn't exist server-side yet, a field we haven't thought of — losing the
    // caret mid-word is worse than any staleness. Every caret-loss bug in this
    // file has been a special case of this rule not existing.
    if (row.key === focusedRowKey) {
      pending.push({ ...anchorsFor(currentKeys, i), row });
      return;
    }
    if (row.desc) {
      // A description exists locally before it exists on the server —
      // `unitsToRows` only emits a desc row once the task HAS one. So a desc row
      // the server lacks is EITHER unsaved work or a description a peer just
      // cleared, and local text cannot tell those apart. Dirtiness can: keep it
      // only if this field is unsaved (protected) or its task isn't confirmed
      // yet. Otherwise the clear is real and must land.
      const owner = field ? field.replace(/#desc$/, "") : null;
      const unsaved = !!field && protectedFields.has(field);
      const ownerPending = !!owner && keepFields.has(owner);
      if (!unsaved && !ownerPending) return;
    } else if (!row.taskId) {
      if (!row.text.trim()) return; // a blank composer nobody is typing in
    } else if (!field || !keepFields.has(field)) {
      return; // a confirmed row the server dropped = a peer's delete. Apply it.
    }
    pending.push({ ...anchorsFor(currentKeys, i), row });
  });
  /** The one blank row an empty outline needs. Reuses the blank row already on
   *  screen when there is one: minting a fresh uuid every merge would change the
   *  row's identity, remounting the textarea and dropping the caret on every
   *  refresh of an empty section. */
  const blankFallback = (): OutlineRow[] => [
    current.find((row) => !row.desc && !row.taskId && !row.text.trim()) ?? newRow(0),
  ];

  // An outline is never rendered with zero rows — there would be nothing to type
  // in. This is the ONLY place a blank row is invented, so the caller must not
  // pre-seed one: doing both is what made them multiply.
  if (!pending.length) return merged.length ? merged : blankFallback();

  const out = [...merged];
  for (const { above, below, row } of pending) {
    // Recomputed EVERY iteration: each splice shifts every later index, so a map
    // taken once before the loop sends the second pending row to the wrong slot —
    // two rows sharing a follower came out reversed, and rows at different anchors
    // bunched together.
    const outFields = rowFieldKeys(out);
    const indexOfField = (field: string | null) => (field ? outFields.indexOf(field) : -1);
    // BEFORE whatever followed it locally. This is the rule that keeps a trailing
    // composer at the bottom when a peer's new task arrives (nothing followed it,
    // so it goes last) while a line opened mid-list stays where it was opened.
    const beforeAt = indexOfField(below);
    if (beforeAt !== -1) {
      out.splice(beforeAt, 0, row);
      continue;
    }
    // Nothing followed it locally → it is the last line, and stays the last line
    // even if the server has since added rows after its anchor.
    if (above !== null || !row.text.trim()) {
      out.push(row);
      continue;
    }
    // No anchor either side and it has TEXT: typed at the very top of the list,
    // where the position is meaningful.
    out.unshift(row);
  }
  return out.length ? out : blankFallback();
}

/* ------------------------------------------------------------------ *
 * Structural keys — what Shift+Tab, Tab, Enter and Backspace DO to the row list.
 *
 * These used to live inside `onRowKeyDown`, where they were reachable only
 * through a real keyboard event on a mounted textarea — so the row surgery for
 * "pop this description line out as a subtask" was never checked by anything, and
 * neither was the create payload it leads to. That is precisely the seam TD2-188
 * went through: the rows were right, the op was right, and the position was lost
 * one layer further down with no test in between.
 *
 * So each key is a pure rows → `RowEdit` function here, and the hook does only
 * what a hook can: write the rows, send the fields, move the caret.
 * ------------------------------------------------------------------ */

/** Everything one structural keystroke changes. The hook applies it; this file
 *  decides it. */
export interface RowEdit {
  /** The new row list. */
  rows: OutlineRow[];
  /** Where the caret goes — always a row that exists in `rows`. */
  focus: { key: string; caret: number };
  /** Indexes into `rows` whose text must be re-sent (a row that changed text, or
   *  changed which field it writes). */
  persist: number[];
  /** A task whose parent or order the USER changed → needs a move op. Present
   *  (even as null) means "tell the structural commit"; absent means nothing
   *  moved. */
  movedId?: string | null;
  /** A task the edit deletes. `indent`/`from` describe the subtree left behind,
   *  which has to be re-parented — see `noteDeleted`. */
  deleted?: { taskId: string | null; indent: number; from: number };
  /** Index of a task row whose folded description changed and must be written
   *  now (not on the throttle) — the owner a popped line was taken from. */
  descOwner?: number;
  /** A row now has text but no task, so creates should be pumped. */
  creates?: boolean;
}

/** The deepest indent the task row at `index` may take: (nearest task above)+1.
 *  -1 = there is no task above to nest under, so Tab means nothing. */
export function maxTaskIndentAt(rows: OutlineRow[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (!rows[i].desc) return rows[i].indent + 1;
  return -1;
}

/**
 * SHIFT+TAB inside a description: pop the line the caret is on out as a bullet —
 * a task at the description's own indent, i.e. a subtask of its owner. Lines
 * above stay the description; lines below become a description of the new
 * bullet. The bullet takes the caret.
 */
export function popDescLine(rows: OutlineRow[], index: number, caret: number): RowEdit | null {
  const row = rows[index];
  if (!row?.desc) return null;
  const val = row.text;
  const at = Math.max(0, Math.min(caret, val.length));
  const lineStart = val.lastIndexOf("\n", at - 1) + 1;
  const nl = val.indexOf("\n", at);
  const lineEnd = nl === -1 ? val.length : nl;
  const before = val.slice(0, lineStart).replace(/\n$/, "");
  const currentLine = val.slice(lineStart, lineEnd);
  const after = val.slice(lineEnd).replace(/^\n/, "");

  const bullet = newRow(row.indent, false, currentLine);
  const inserts: OutlineRow[] = [bullet];
  if (after.trim()) inserts.push(newRow(row.indent + 1, true, after));
  const copy = rows.slice();
  if (before.trim()) {
    copy[index] = { ...row, text: before };
    copy.splice(index + 1, 0, ...inserts);
  } else {
    copy.splice(index, 1, ...inserts); // the desc had only this line → replace it
  }
  const kept = copy.findIndex((r) => r.desc && r.key === row.key);
  const bulletIndex = copy.findIndex((r) => r.key === bullet.key);
  const owner = descOwnerAt(copy, bulletIndex);
  const ownerIndex = owner ? copy.findIndex((r) => r.key === owner.key) : -1;
  return {
    rows: copy,
    focus: { key: bullet.key, caret: currentLine.length },
    persist: kept >= 0 ? [kept] : [],
    // The owner lost a line whether or not a desc row survived to carry the
    // write — when it didn't, this is the ONLY thing that clears the column.
    ...(ownerIndex >= 0 ? { descOwner: ownerIndex } : {}),
    creates: true,
  };
}

/** TAB / SHIFT+TAB on a task row: outdent, nest one deeper, or — already as deep
 *  as allowed — stop being a task and join the owner's description. Null when
 *  the key means nothing (the first line, or the left edge). */
export function retabRow(
  rows: OutlineRow[],
  index: number,
  opts: { shift: boolean; caret: number },
): RowEdit | null {
  const row = rows[index];
  if (!row || row.desc) return null;
  const max = maxTaskIndentAt(rows, index);
  if (max < 0) return null; // first line — nothing above to nest under
  const focus = { key: row.key, caret: opts.caret };
  if (opts.shift) {
    if (row.indent === 0) return null; // at the left edge, nothing happens
    return {
      rows: rows.map((r) => (r.key === row.key ? { ...r, indent: r.indent - 1 } : r)),
      focus,
      persist: [],
      movedId: row.taskId,
    };
  }
  if (row.indent < max) {
    return {
      rows: rows.map((r) => (r.key === row.key ? { ...r, indent: r.indent + 1 } : r)),
      focus,
      persist: [],
      movedId: row.taskId,
    };
  }
  // Deepest role already → the line becomes its parent's description. The task
  // stops existing: an explicit delete, and its text joins the owner's field.
  const copy = rows.map((r) => (r.key === row.key ? { ...r, desc: true, taskId: null } : r));
  const di = copy.findIndex((r) => r.key === row.key);
  return {
    rows: copy,
    focus,
    persist: di >= 0 ? [di] : [],
    deleted: { taskId: row.taskId, indent: row.indent, from: index + 1 },
  };
}

/** ENTER on a task row: split at the caret into a new sibling. A bound task keeps
 *  its id on the head (same task, renamed); the tail is a new task. */
export function splitRow(rows: OutlineRow[], index: number, caret: number): RowEdit | null {
  const row = rows[index];
  if (!row || row.desc) return null;
  const at = Math.max(0, Math.min(caret, row.text.length));
  const created = newRow(row.indent, false, row.text.slice(at));
  const copy = rows.slice();
  copy[index] = { ...row, text: row.text.slice(0, at) };
  copy.splice(index + 1, 0, created);
  return {
    rows: copy,
    focus: { key: created.key, caret: 0 },
    persist: [index], // the head's title changed
    creates: true,
  };
}

/** BACKSPACE at offset 0: merge into the previous row, whose id and role win.
 *  This row is dropped, so its task — if it had one — is deliberately deleted. */
export function mergeIntoPrevious(rows: OutlineRow[], index: number): RowEdit | null {
  const row = rows[index];
  const prev = rows[index - 1];
  if (!row || !prev || row.desc) return null;
  const copy = rows.slice();
  copy[index - 1] = { ...prev, text: prev.text + row.text };
  copy.splice(index, 1);
  return {
    rows: copy,
    focus: { key: prev.key, caret: prev.text.length },
    persist: [index - 1],
    deleted: { taskId: row.taskId, indent: row.indent, from: index },
  };
}

/* ------------------------------------------------------------------ *
 * Op payloads — the last step before the wire.
 *
 * `position` here is the whole point of the fractional key: it says WHERE the
 * line was opened. It was computed correctly, put on the op correctly, and then
 * dropped by the request schema and by `createTask` (TD2-188) — so these are
 * built here, where a check can read them, rather than inline in an async pump.
 * ------------------------------------------------------------------ */

/** The next row a create is allowed to run for: has text, has no task, isn't
 *  already being created, and has no unbound ancestor to wait for (a child can't
 *  be created before its parent has an id). -1 when there is nothing to do. */
export function nextCreatableIndex(
  rows: OutlineRow[],
  busy: (row: OutlineRow) => boolean,
): number {
  return rows.findIndex((r, i) => {
    if (r.desc || r.taskId || busy(r)) return false;
    if (!r.text.trim()) return false;
    const parent = parentRowAt(rows, i);
    return !parent || !!parent.taskId;
  });
}

/** The `create` op for a row: its title, the description folded from the desc
 *  rows under it, its parent, and the fractional key that places it between its
 *  neighbours. Only a ROOT line carries the pin/bucket — a subtask inherits its
 *  parent's. */
export function createOpFor(
  rows: OutlineRow[],
  index: number,
  opts: {
    boardId: string;
    positionOf: (taskId: string) => number | undefined;
    rootTarget: Record<string, unknown>;
    /** Who the new task is for (TD2-193). Set when the list is being written
     *  under an assignee filter: a line created with nobody on it would be
     *  filtered straight back off the screen it was typed on. Applies to
     *  subtask lines too, which is why it isn't part of `rootTarget`. */
    assigneeIds?: string[];
  },
): {
  op: "create";
  input: {
    title: string;
    description?: string;
    boardId: string;
    parentId?: string;
    position: number;
  } & Record<string, unknown>;
} | null {
  const row = rows[index];
  if (!row || row.desc || !row.text.trim()) return null;
  const parent = parentRowAt(rows, index);
  const description = foldedDescriptionFor(rows, index);
  return {
    op: "create",
    input: {
      title: row.text.trim(),
      description: description || undefined,
      boardId: opts.boardId,
      parentId: parent?.taskId ?? undefined,
      position: siblingPositionAt(rows, index, opts.positionOf),
      ...(parent ? {} : opts.rootTarget),
      ...(opts.assigneeIds?.length ? { assigneeIds: opts.assigneeIds } : {}),
    },
  };
}

/**
 * The re-parent ops for descendants the outline COULDN'T SEE when their parent's
 * line was deleted (TD2-194/TD2-216).
 *
 * Deleting a line re-parents what was nested under it — the editor does that by
 * walking the rows that are on screen. Under a filter, some of the dead task's
 * children have no row at all, so nothing claims them, and `deleteTask` promotes
 * an orphan to root at the END of its group: work nobody was looking at moves,
 * with nothing on screen to explain it.
 *
 * There is no row to derive a target from, so the op is written out directly:
 * the parent the deleted task itself had, and the position the child already
 * holds — which leaves it exactly where it was among its new siblings.
 *
 * Cheap and correct to run unconditionally: with no filter every child IS on
 * screen, so `shown` covers them all and this returns nothing.
 */
export function hiddenOrphanMoves(
  deletedIds: Iterable<string>,
  shown: ReadonlySet<string>,
  scope: readonly { id: string; parentId: string | null; position: number }[],
  positionOf: (taskId: string) => number | undefined,
): { op: "move"; id: string; target: { parentId: string | null; position: number } }[] {
  const dead = new Set(deletedIds);
  const out: {
    op: "move";
    id: string;
    target: { parentId: string | null; position: number };
  }[] = [];
  for (const id of dead) {
    const grandparent = scope.find((n) => n.id === id)?.parentId ?? null;
    for (const child of scope) {
      if (child.parentId !== id) continue;
      // On screen ⇒ the editor's own walk already claimed it. Also dying ⇒ there
      // is nothing left to re-parent it onto.
      if (shown.has(child.id) || dead.has(child.id)) continue;
      out.push({
        op: "move",
        id: child.id,
        target: { parentId: grandparent, position: positionOf(child.id) ?? child.position },
      });
    }
  }
  return out;
}

/** The `move` op for a bound row: where it now hangs and where it now sorts. */
export function moveOpFor(
  rows: OutlineRow[],
  index: number,
  positionOf: (taskId: string) => number | undefined,
): { op: "move"; id: string; target: { parentId: string | null; position: number } } | null {
  const row = rows[index];
  if (!row || row.desc || !row.taskId) return null;
  const parent = parentRowAt(rows, index);
  return {
    op: "move",
    id: row.taskId,
    target: {
      parentId: parent?.taskId ?? null,
      position: siblingPositionAt(rows, index, positionOf),
    },
  };
}

/**
 * What a row must contain the instant someone takes it over.
 *
 * A row is one task field, and a field patch carries the whole value, so the
 * taker's first keystroke overwrites whatever THEY have on screen. If that is a
 * snapshot from before the previous owner's last sentence, taking a row silently
 * deletes work. So a takeover never opens a row against the local copy: it opens
 * it against `authoritative` — the value everyone else has, which arrives as a
 * `task-patch` broadcast and needs no database read.
 *
 * `pending` is the keystroke that ASKED for a parked row (typing is how you take
 * one). It was held rather than applied, because applying it would have written
 * it onto the text we are about to replace. It is replayed here:
 *   • text unchanged → at the offset the user typed it at, as if nothing happened;
 *   • text changed → at the END, because an offset into a sentence the user never
 *     read means nothing, and dropping their character means the keystroke that
 *     took the row also vanished.
 */
export function takeoverText(
  authoritative: string,
  mine: string,
  pending?: { insert: string; at: number } | null,
): { text: string; caret: number; changed: boolean } {
  const changed = mine !== authoritative;
  if (!pending) return { text: authoritative, caret: authoritative.length, changed };
  const at = changed
    ? authoritative.length
    : Math.max(0, Math.min(pending.at, authoritative.length));
  return {
    text: authoritative.slice(0, at) + pending.insert + authoritative.slice(at),
    caret: at + pending.insert.length,
    changed,
  };
}
