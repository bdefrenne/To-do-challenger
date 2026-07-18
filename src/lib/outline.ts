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
