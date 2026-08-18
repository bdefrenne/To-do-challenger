/**
 * Outline model for canvas Sections — the pure logic behind the two-mode
 * editor. A Section's authoring surface is a flat list of `OutlineRow`s. Each
 * row is either a TASK at some `indent` depth (0 = top level, 1 = subtask, 2 =
 * sub-subtask, …) or a `desc` — a multiline description block belonging to the
 * nearest task above it. Task rows carry a bound `taskId` so re-editing patches
 * the same task instead of duplicating it.
 *
 * Keyboard mapping lives in SectionNode; here we only convert rows ⇄ a task
 * tree. This file is UI-free and side-effect-free so it's easy to test.
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
/** The field a preserved row hangs off: the nearest one above it. Null when it is
 *  at the very top with nothing identifiable before it. */
function anchorFieldFor(fields: (string | null)[], index: number): string | null {
  for (let j = index - 1; j >= 0; j--) if (fields[j]) return fields[j];
  return null;
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
    if (field && !mine.has(field)) mine.set(field, current[i]);
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
  const pending: { afterField: string | null; row: OutlineRow }[] = [];
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
      pending.push({ afterField: anchorFieldFor(currentKeys, i), row });
      return;
    }
    if (row.desc) {
      // A description exists locally before it exists on the server —
      // `unitsToRows` only emits a desc row once the task HAS a description. So
      // text here is unsaved work, not a deletion.
      if (!row.text.trim()) return;
    } else if (!row.taskId) {
      if (!row.text.trim()) return; // a blank composer nobody is typing in
    } else if (!field || !keepFields.has(field)) {
      return; // a confirmed row the server dropped = a peer's delete. Apply it.
    }
    pending.push({ afterField: anchorFieldFor(currentKeys, i), row });
  });
  // An outline is never rendered with zero rows — there would be nothing to type
  // in. This is the ONLY place a blank row is invented, so the caller must not
  // pre-seed one: doing both is what made them multiply.
  if (!pending.length) return merged.length ? merged : [newRow(0)];

  const out = [...merged];
  const mergedKeys = rowFieldKeys(out);
  for (const { afterField, row } of pending) {
    if (afterField === null) {
      // No anchor above it. A row with TEXT was typed at the top of the list, so
      // its position is meaningful and it stays first. A BLANK row is the trailing
      // composer — the line you are about to type in — so it belongs at the END,
      // not shoved above a task a peer just added.
      if (row.text.trim()) out.unshift(row);
      else out.push(row);
      continue;
    }
    let at = -1;
    for (let i = mergedKeys.length - 1; i >= 0; i--) {
      if (mergedKeys[i] === afterField) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      // Its anchor is gone (a peer deleted that task) — keep the row at the end
      // rather than lose what the user typed.
      out.push(row);
      continue;
    }
    // Insert after the anchor's SUBTREE, not immediately after its title line.
    // "After the parent" has to mean after everything nested under it, or the row
    // wedges between a parent and its own subtasks — which is what a peer saw
    // while someone else was building a nested list. Rows deeper than this one
    // belong above it; a row at this row's level or shallower ends the search.
    let insertAt = at + 1;
    while (insertAt < out.length && (out[insertAt].desc || out[insertAt].indent > row.indent)) {
      insertAt++;
    }
    out.splice(insertAt, 0, row);
  }
  return out.length ? out : [newRow(0)];
}
