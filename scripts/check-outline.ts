/**
 * Outline logic checks — the pure rules behind the text view.
 *
 * `npm run check:outline`
 *
 * Every one of these exists because something broke in front of Ben. The outline
 * is where co-editing, task creation and deletion all meet, so a wrong answer
 * here doesn't render oddly — it loses a task, duplicates one, or yanks the caret
 * out of someone's hands. The merge in particular has been rewritten five times;
 * this file is what stops each fix reintroducing an earlier bug.
 *
 * Pure functions only: no room, no database, no React.
 */

import {
  type OutlineRow,
  type RowEdit,
  mergeOutlineRows,
  rowFieldKey,
  rowFieldKeys,
  parentRowAt,
  descOwnerAt,
  foldedDescriptionFor,
  siblingPositionAt,
  rowsToUnits,
  unitsToRows,
  survivingIds,
  newRow,
  takeoverText,
  maxTaskIndentAt,
  popDescLine,
  retabRow,
  splitRow,
  mergeIntoPrevious,
  nextCreatableIndex,
  createOpFor,
  hiddenOrphanMoves,
  moveOpFor,
} from "@/lib/outline";
import {
  NO_FILTER,
  filterUnits,
  makeNodeMatcher,
  makeRenderFilter,
  makeTaskPredicate,
} from "@/lib/task-filters";
import { resolveRowLock, PARK_MS, type RowClaim } from "@/components/workspace/useRowLock";

/* ------------------------------- harness ------------------------------- */

let passed = 0;
const failures: string[] = [];
let section = "";

const group = (name: string) => {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures.push(`${section} → ${name}\n       got  ${g}\n       want ${w}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       got  ${g}\n       want ${w}`);
  }
};

/** A row. Defaults keep the call sites readable. */
const r = (
  key: string,
  taskId: string | null,
  text: string,
  indent = 0,
  desc = false,
): OutlineRow => ({ key, taskId, indent, desc, text });
/** Rendered shape: indentation + text, descriptions marked. */
const view = (rows: OutlineRow[]) =>
  rows.map((x) => `${"  ".repeat(x.indent)}${x.desc ? "// " : ""}${x.text || "task…"}`);
const keys = (rows: OutlineRow[]) => rows.map((x) => x.key);

/* --------------------------- field identity ---------------------------- */

group("rowFieldKeys — a row IS one task field");
{
  const rows = [
    r("a", "t1", "one"),
    r("ad", null, "its description", 1, true),
    r("b", "t2", "two", 1),
    r("c", null, "not created yet"),
    r("cd", null, "desc of an uncreated task", 1, true),
  ];
  eq("title → task id, desc → owner#desc, uncreated → null", rowFieldKeys(rows), [
    "t1",
    "t1#desc",
    "t2",
    null,
    null,
  ]);
  eq("single-row helper agrees with the batch", rows.map((_, i) => rowFieldKey(rows, i)), rowFieldKeys(rows));
  eq("a desc before ANY task has no owner", rowFieldKeys([r("d", null, "orphan", 0, true)]), [null]);
  eq("out-of-range index is null, not a crash", rowFieldKey(rows, 99), null);
  eq("empty list", rowFieldKeys([]), []);
  eq("two desc rows share ONE field (they are one column)",
     rowFieldKeys([r("a", "t1", "x"), r("d1", null, "l1", 1, true), r("d2", null, "l2", 1, true)]),
     ["t1", "t1#desc", "t1#desc"]);
}

/* ------------------------------ structure ------------------------------ */

group("parentRowAt / descOwnerAt — who a row hangs off");
{
  const rows = [
    r("a", "t1", "root"),
    r("ad", null, "desc", 1, true),
    r("b", "t2", "child", 1),
    r("c", "t3", "grandchild", 2),
    r("d", "t4", "second root"),
  ];
  eq("root has no parent", parentRowAt(rows, 0)?.taskId ?? null, null);
  eq("child's parent is the shallower row above", parentRowAt(rows, 2)?.taskId, "t1");
  eq("grandchild's parent is the child", parentRowAt(rows, 3)?.taskId, "t2");
  eq("desc rows are skipped when finding a parent", parentRowAt(rows, 2)?.key, "a");
  eq("a later root has no parent", parentRowAt(rows, 4)?.taskId ?? null, null);
  eq("desc belongs to the nearest task above", descOwnerAt(rows, 1)?.taskId, "t1");
  eq("desc with nothing above → null", descOwnerAt([r("d", null, "x", 0, true)], 0), null);
  eq("out of range → null", parentRowAt(rows, 99), null);
  // A row indented deeper than its predecessor allows: rowsToUnits clamps, and the
  // parent lookup must not invent a level.
  const skipped = [r("a", "t1", "root"), r("b", "t2", "leaps to 3", 3)];
  eq("an over-indented row still parents to the row above", parentRowAt(skipped, 1)?.taskId, "t1");
}

group("foldedDescriptionFor — every desc line of a task is ONE column");
{
  const rows = [
    r("a", "t1", "task"),
    r("d1", null, "first line", 1, true),
    r("d2", null, "second line", 1, true),
    r("b", "t2", "next task"),
    r("d3", null, "other task's desc", 1, true),
  ];
  eq("folds this task's lines only", foldedDescriptionFor(rows, 0), "first line\nsecond line");
  eq("stops at the next task row", foldedDescriptionFor(rows, 3), "other task's desc");
  eq("no description → empty string", foldedDescriptionFor([r("a", "t1", "x")], 0), "");
  eq("blank desc lines are dropped", foldedDescriptionFor([r("a", "t1", "x"), r("d", null, "   ", 1, true)], 0), "");
  eq("whitespace around a line is trimmed",
     foldedDescriptionFor([r("a", "t1", "x"), r("d", null, "  hi  ", 1, true)], 0), "hi");
  eq("a multiline desc row keeps its own newlines",
     foldedDescriptionFor([r("a", "t1", "x"), r("d", null, "l1\nl2", 1, true)], 0), "l1\nl2");
}

group("siblingPositionAt — fractional keys, never a renumber");
{
  const pos: Record<string, number> = { a: 10, b: 20, c: 30 };
  const at = (rows: OutlineRow[], i: number, map = pos) =>
    siblingPositionAt(rows, i, (id) => map[id]);
  eq("between two siblings → the midpoint",
     at([r("ka", "a", "a"), r("new", null, "x"), r("kb", "b", "b")], 1), 15);
  eq("after the last sibling → +1", at([r("ka", "a", "a"), r("new", null, "x")], 1), 11);
  eq("before the first sibling → -1", at([r("new", null, "x"), r("ka", "a", "a")], 0), 9);
  eq("no known siblings → 0", at([r("new", null, "x")], 0), 0);
  eq("a sibling with an unknown position is skipped",
     at([r("ka", "a", "a"), r("kq", "q", "q"), r("new", null, "x")], 2), 11);
  eq("desc rows are not siblings",
     at([r("ka", "a", "a"), r("d", null, "desc", 1, true), r("new", null, "x")], 2), 11);
  eq("a different parent is a different group",
     at([r("ka", "a", "a"), r("kb", "b", "b", 1), r("new", null, "x", 1)], 2, { a: 10, b: 20 }), 21);
  eq("children of different parents don't mix",
     at([r("ka", "a", "p1"), r("kb", "b", "kid of a", 1), r("kc", "c", "p2"), r("new", null, "kid of c", 1)], 3),
     0);
  eq("repeated midpoints keep shrinking (no collision)",
     at([r("ka", "a", "a"), r("new", null, "x"), r("kb", "b", "b")], 1, { a: 10, b: 11 }), 10.5);
  eq("out of range → 0", at([], 0), 0);
}

group("siblingPositionAt — a line opened MID-LIST is not a new last item (TD2-188)");
{
  // The reported shape: a task with a description and three subtasks. Shift+Tab
  // on the description line pops it out as the FIRST subtask — so the key it asks
  // for must sort BEFORE the existing children. It did; the create threw the key
  // away server-side and appended, and the row (with the caret in it) jumped to
  // the bottom of the list on the next refetch. These pin the row-side contract
  // the server now has to honour.
  const pos: Record<string, number> = { t: 1, a: 2, b: 3, c: 4 };
  const at = (rows: OutlineRow[], i: number) => siblingPositionAt(rows, i, (id) => pos[id]);
  const popped = [
    r("kt", "t", "New task here"),
    r("kn", null, "desc", 1), // ← the bullet Shift+Tab just made
    r("ka", "a", "sous task", 1),
    r("kd", null, "sous task desc", 2, true),
    r("kb", "b", "subtask", 1),
    r("kc", "c", "sub", 1),
  ];
  eq("the popped line nests under the task it described", parentRowAt(popped, 1)?.taskId, "t");
  eq("…and asks for a key BEFORE the first existing subtask", at(popped, 1), 1);
  eq("…so the owner's description is now empty, not the popped line",
     foldedDescriptionFor(popped, 0), "");

  // Same key, wherever in the block the caret was: popping the second line of a
  // description leaves the first line behind as a desc row and the bullet still
  // sorts first.
  const mid = [
    r("kt", "t", "New task here"),
    r("kdesc", null, "kept line", 1, true),
    r("kn", null, "popped line", 1),
    r("ka", "a", "sous task", 1),
    r("kb", "b", "subtask", 1),
  ];
  eq("a line popped from the MIDDLE of a description still sorts first", at(mid, 2), 1);
  eq("…and the lines above it stay the owner's description",
     foldedDescriptionFor(mid, 0), "kept line");

  // A subtask's own description pops out as ITS child, in a group of its own.
  const nested = [
    r("kt", "t", "New task here"),
    r("ka", "a", "sous task", 1),
    r("kn", null, "sous task desc", 2),
    r("kb", "b", "subtask", 1),
  ];
  eq("a subtask's description pops out under the SUBTASK", parentRowAt(nested, 2)?.taskId, "a");
  eq("…into an empty group, where any key will do", at(nested, 2), 0);

  // The first task in a list with no description: nothing above, so it is a root
  // line and must land before the roots that exist.
  const top = [r("kn", null, "typed at the top", 0), r("kt", "t", "New task here")];
  eq("a line opened at the very top asks for a key before the first root", at(top, 0), 0);

  // Enter mid-list — the same class of bug, same fix.
  const split = [
    r("kt", "t", "New task here"),
    r("ka", "a", "sous task", 1),
    r("kn", null, "split off b", 1),
    r("kb", "b", "subtask", 1),
    r("kc", "c", "sub", 1),
  ];
  eq("an Enter split mid-list asks for the midpoint of its neighbours", at(split, 2), 2.5);
  eq("appending really is the LAST line's answer — the default must stay",
     at([...popped, r("kend", null, "appended", 1)], 6), 5);
}

/* ------------------------ rows ⇄ units round trip ----------------------- */

group("rowsToUnits / unitsToRows — the tree the outline saves");
{
  const rows = [
    r("a", "t1", "parent"),
    r("ad", null, "about it", 1, true),
    r("b", "t2", "child", 1),
    r("c", null, "  ", 2), // blank → dropped
    r("d", "t3", "second root"),
  ];
  const units = rowsToUnits(rows);
  eq("roots", units.map((u) => u.title), ["parent", "second root"]);
  eq("description folded onto the parent", units[0].description, "about it");
  eq("child nested", units[0].children.map((c) => c.title), ["child"]);
  eq("blank row contributes nothing", survivingIds(units).has("t2"), true);
  eq("a dropped blank row's id does not survive", [...survivingIds(units)].sort(), ["t1", "t2", "t3"]);
  eq("round trip preserves the rendered shape",
     view(unitsToRows(units)),
     ["parent", "  // about it", "  child", "second root"]);
  eq("an orphan desc is promoted to a task",
     rowsToUnits([r("d", null, "orphan", 0, true)]).map((u) => u.title), ["orphan"]);
  eq("empty rows → no units", rowsToUnits([r("x", null, "")]).length, 0);
  eq("newRow is blank and unbound", [newRow(2).indent, newRow(2).taskId, newRow(2).text], [2, null, ""]);
}

/* ------------------------------- the merge ------------------------------ */

group("mergeOutlineRows — nothing on screen, nothing on the server");
{
  eq("both empty → one blank line to type in", view(mergeOutlineRows([], [], new Set())), ["task…"]);
  eq("server empty, my blank row focused → keep MINE (caret intact)",
     keys(mergeOutlineRows([], [r("mine", null, "")], new Set(), "mine")), ["mine"]);
  eq("server empty, my blank row unfocused → one row, REUSING its identity",
     keys(mergeOutlineRows([], [r("stale", null, "")], new Set())), ["stale"]);
  eq("…and with no blank row to reuse, exactly one is invented",
     mergeOutlineRows([], [], new Set()).length, 1);
  eq("server empty, my TYPED row → kept, never invented over",
     view(mergeOutlineRows([], [r("new", null, "precious")], new Set())), ["precious"]);
  eq("nothing local → the server's list, as-is",
     view(mergeOutlineRows([r("s1", "t1", "from server")], [], new Set())), ["from server"]);
}

group("mergeOutlineRows — keys, so the caret's DOM node survives");
{
  const current = [r("k1", "t1", "one"), r("k2", "t2", "two")];
  const seeded = [r("s1", "t1", "one"), r("s2", "t2", "two")];
  eq("matching fields keep MY keys", keys(mergeOutlineRows(seeded, current, new Set())), ["k1", "k2"]);
  eq("a row only the server has takes the server's key",
     keys(mergeOutlineRows([...seeded, r("s3", "t3", "new")], current, new Set())), ["k1", "k2", "s3"]);
}

group("mergeOutlineRows — text: whose wins");
{
  const current = [r("k1", "t1", "mine, unsaved"), r("k2", "t2", "untouched")];
  const seeded = [r("s1", "t1", "theirs"), r("s2", "t2", "theirs too")];
  eq("unprotected → the server's text lands",
     view(mergeOutlineRows(seeded, current, new Set())), ["theirs", "theirs too"]);
  eq("protected field → my text stays",
     view(mergeOutlineRows(seeded, current, new Set(["t1"]))), ["mine, unsaved", "theirs too"]);
  eq("protection is per field, not per list",
     view(mergeOutlineRows(seeded, current, new Set(["t2"]))), ["theirs", "untouched"]);
  eq("focus alone does not protect text (the caller adds the field)",
     view(mergeOutlineRows(seeded, current, new Set(), "k1")), ["theirs", "theirs too"]);
}

group("mergeOutlineRows — structure is the server's");
{
  eq("a peer's nesting applies, my text is protected",
     view(mergeOutlineRows(
       [r("s1", "t1", "parent"), r("s2", "t2", "now a child", 1)],
       [r("k1", "t1", "parent"), r("k2", "t2", "mine", 0)],
       new Set(["t2"]))),
     ["parent", "  mine"]);
  eq("a peer's reorder applies and keys follow their rows",
     keys(mergeOutlineRows(
       [r("s2", "t2", "two"), r("s1", "t1", "one")],
       [r("k1", "t1", "one"), r("k2", "t2", "two")],
       new Set())),
     ["k2", "k1"]);
  eq("a peer's outdent applies",
     view(mergeOutlineRows(
       [r("s1", "t1", "p"), r("s2", "t2", "promoted", 0)],
       [r("k1", "t1", "p"), r("k2", "t2", "promoted", 1)],
       new Set())),
     ["p", "promoted"]);
}

group("mergeOutlineRows — deletes: apply a peer's, never your own work");
{
  const current = [r("k1", "t1", "stays"), r("k2", "t2", "goes")];
  const seeded = [r("s1", "t1", "stays")];
  eq("a confirmed row the server dropped is a peer delete",
     view(mergeOutlineRows(seeded, current, new Set())), ["stays"]);
  eq("…but NOT the row the caret is in (the invariant)",
     view(mergeOutlineRows(seeded, current, new Set(), "k2")), ["stays", "goes"]);
  eq("…and NOT a task we created that the server hasn't echoed",
     view(mergeOutlineRows(seeded, current, new Set(), null, new Set(["t2"]))), ["stays", "goes"]);
  eq("keepFields naming a field the server HAS makes no duplicate",
     view(mergeOutlineRows([r("s1", "t1", "stays"), r("s2", "t2", "goes")], current, new Set(), null, new Set(["t2"]))),
     ["stays", "goes"]);
  eq("everything deleted while I hold a row → just my row",
     view(mergeOutlineRows([], current, new Set(), "k2")), ["goes"]);
}

group("mergeOutlineRows — pending rows land where they were");
{
  eq("trailing composer stays trailing when a peer appends",
     view(mergeOutlineRows(
       [r("s1", "t1", "first"), r("s2", "t2", "peer's new task")],
       [r("k1", "t1", "first"), r("blank", null, "")],
       new Set(), "blank")),
     ["first", "peer's new task", "task…"]);
  eq("a line opened mid-list stays mid-list",
     view(mergeOutlineRows(
       [r("s1", "t1", "first"), r("s2", "t2", "second"), r("s3", "t3", "appended")],
       [r("k1", "t1", "first"), r("blank", null, ""), r("k2", "t2", "second")],
       new Set(), "blank")),
     ["first", "task…", "second", "appended"]);
  eq("typed pending row keeps its slot",
     view(mergeOutlineRows(
       [r("s1", "t1", "first"), r("s2", "t2", "second")],
       [r("k1", "t1", "first"), r("new", null, "typed"), r("k2", "t2", "second")],
       new Set())),
     ["first", "typed", "second"]);
  eq("typed at the very top leads",
     view(mergeOutlineRows([r("s1", "t1", "a")], [r("new", null, "top"), r("k1", "t1", "a")], new Set())),
     ["top", "a"]);
  eq("composer lands after a whole subtree, not inside it",
     view(mergeOutlineRows(
       [r("s1", "t1", "parent"), r("s2", "t2", "kid", 1), r("s3", "t3", "grandkid", 2)],
       [r("k1", "t1", "parent"), r("blank", null, "")],
       new Set(), "blank")),
     ["parent", "  kid", "    grandkid", "task…"]);
  eq("a nested pending row stays nested",
     view(mergeOutlineRows(
       [r("s1", "t1", "parent"), r("s2", "t2", "kid", 1)],
       [r("k1", "t1", "parent"), r("k2", "t2", "kid", 1), r("new", null, "sibling", 1)],
       new Set(), "new")),
     ["parent", "  kid", "  sibling"]);
  eq("its follower was deleted by a peer → falls to the end rather than vanishing",
     view(mergeOutlineRows(
       [r("s1", "t1", "first")],
       [r("k1", "t1", "first"), r("new", null, "typed"), r("k2", "t2", "deleted by peer")],
       new Set())),
     ["first", "typed"]);
  eq("two pending rows keep their relative order",
     view(mergeOutlineRows(
       [r("s1", "t1", "first")],
       [r("k1", "t1", "first"), r("n1", null, "one"), r("n2", null, "two")],
       new Set())),
     ["first", "one", "two"]);
  // Each insert shifts every later index. These three caught a real reversal.
  eq("two pending rows sharing ONE follower stay in order",
     view(mergeOutlineRows(
       [r("s1", "t1", "A"), r("s2", "t2", "B")],
       [r("k1", "t1", "A"), r("n1", null, "one"), r("n2", null, "two"), r("k2", "t2", "B")],
       new Set())),
     ["A", "one", "two", "B"]);
  eq("pending rows at different anchors each land at their own",
     view(mergeOutlineRows(
       [r("s1", "t1", "A"), r("s2", "t2", "B"), r("s3", "t3", "C")],
       [r("k1", "t1", "A"), r("n1", null, "after A"), r("k2", "t2", "B"), r("n2", null, "after B"), r("k3", "t3", "C")],
       new Set())),
     ["A", "after A", "B", "after B", "C"]);
  eq("a pending row before the very first row",
     view(mergeOutlineRows(
       [r("s1", "t1", "A"), r("s2", "t2", "B")],
       [r("n1", null, "first"), r("k1", "t1", "A"), r("k2", "t2", "B")],
       new Set())),
     ["first", "A", "B"]);
  eq("five pending rows interleaved with four server rows",
     view(mergeOutlineRows(
       [r("s1", "t1", "1"), r("s2", "t2", "2"), r("s3", "t3", "3"), r("s4", "t4", "4")],
       [r("p0", null, "p0"), r("k1", "t1", "1"), r("p1", null, "p1"), r("k2", "t2", "2"),
        r("p2", null, "p2"), r("p3", null, "p3"), r("k3", "t3", "3"), r("k4", "t4", "4"), r("p4", null, "p4")],
       new Set())),
     ["p0", "1", "p1", "2", "p2", "p3", "3", "4", "p4"]);
  eq("a blank FOCUSED desc row is kept by the invariant (caret is in it)",
     keys(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "", 1, true)],
       new Set(), "d1")),
     ["k1", "d1"]);
  eq("…and dropped once the caret leaves it",
     keys(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "", 1, true)],
       new Set(), null)),
     ["k1"]);
  eq("the FIRST of two desc rows focused keeps its key too",
     keys(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "l1\nl2", 1, true)],
       [r("k1", "t1", "task"), r("d1", null, "l1", 1, true), r("d2", null, "l2", 1, true)],
       new Set(), "d1")),
     ["k1", "d1"]);
  eq("a field both protected AND unconfirmed keeps my text and the row",
     view(mergeOutlineRows(
       [r("s1", "t1", "parent")],
       [r("k1", "t1", "parent"), r("k2", "t2", "mine", 1)],
       new Set(["t2"]), null, new Set(["t2"]))),
     ["parent", "  mine"]);
  eq("a pending row keeps its own indent, not the server's neighbours'",
     view(mergeOutlineRows(
       [r("s1", "t1", "parent")],
       [r("k1", "t1", "parent"), r("n1", null, "deep", 3)],
       new Set())),
     ["parent", "      deep"]);
  eq("blank rows nobody is in are not preserved",
     view(mergeOutlineRows(
       [r("s1", "t1", "first")],
       [r("k1", "t1", "first"), r("b1", null, ""), r("b2", null, "")],
       new Set())),
     ["first"]);
}

group("mergeOutlineRows — descriptions");
{
  eq("a peer's new description appears under its owner",
     view(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "peer wrote this", 1, true)],
       [r("k1", "t1", "task")],
       new Set())),
     ["task", "  // peer wrote this"]);
  eq("a peer clearing a description removes the row",
     view(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "was here", 1, true)],
       new Set())),
     ["task"]);
  eq("MY unsaved description survives (the server has none yet)",
     view(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "typing now", 1, true)],
       new Set(["t1#desc"]), "d1")),
     ["task", "  // typing now"]);
  eq("…and keeps its key so the caret lives",
     keys(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "typing now", 1, true)],
       new Set(["t1#desc"]), "d1")),
     ["k1", "d1"]);
  eq("an unsaved description of an UNCONFIRMED task survives too",
     view(mergeOutlineRows(
       [],
       [r("k1", "t1", "just created"), r("d1", null, "and described", 1, true)],
       new Set(), "d1", new Set(["t1"]))),
     ["just created", "  // and described"]);
  eq("a blank description nobody is in is dropped",
     view(mergeOutlineRows(
       [r("s1", "t1", "task")],
       [r("k1", "t1", "task"), r("d1", null, "   ", 1, true)],
       new Set())),
     ["task"]);
  eq("description sits between parent and children, never after them",
     view(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "desc", 1, true), r("s2", "t2", "kid", 1)],
       [r("k1", "t1", "task"), r("d1", null, "desc", 1, true), r("k2", "t2", "kid", 1)],
       new Set())),
     ["task", "  // desc", "  kid"]);
  eq("protecting the title does NOT protect the description",
     view(mergeOutlineRows(
       [r("s1", "t1", "server title"), r("sd", null, "server desc", 1, true)],
       [r("k1", "t1", "my title"), r("d1", null, "my desc", 1, true)],
       new Set(["t1"]))),
     ["my title", "  // server desc"]);
  eq("two local desc rows for one task collapse to the canonical single row",
     view(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "l1\nl2", 1, true)],
       [r("k1", "t1", "task"), r("d1", null, "l1", 1, true), r("d2", null, "l2", 1, true)],
       new Set())),
     ["task", "  // l1\nl2"]);
  eq("…and when the caret is in the SECOND of them, it is not duplicated",
     view(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "l1\nl2", 1, true)],
       [r("k1", "t1", "task"), r("d1", null, "l1", 1, true), r("d2", null, "l2", 1, true)],
       new Set(), "d2")),
     ["task", "  // l1\nl2"]);
  eq("…keeping the FOCUSED row's key, so the caret survives the collapse",
     keys(mergeOutlineRows(
       [r("s1", "t1", "task"), r("sd", null, "l1\nl2", 1, true)],
       [r("k1", "t1", "task"), r("d1", null, "l1", 1, true), r("d2", null, "l2", 1, true)],
       new Set(), "d2")),
     ["k1", "d2"]);
}

group("mergeOutlineRows — hostile inputs must not throw");
{
  eq("focusedRowKey naming a row that doesn't exist",
     view(mergeOutlineRows([r("s1", "t1", "a")], [r("k1", "t1", "a")], new Set(), "ghost")), ["a"]);
  eq("protectedFields naming an absent field",
     view(mergeOutlineRows([r("s1", "t1", "a")], [r("k1", "t1", "a")], new Set(["nope"]))), ["a"]);
  eq("keepFields naming an absent field",
     view(mergeOutlineRows([r("s1", "t1", "a")], [r("k1", "t1", "a")], new Set(), null, new Set(["nope"]))), ["a"]);
  eq("a server task with an empty title still renders a row",
     view(mergeOutlineRows([r("s1", "t1", "")], [], new Set())), ["task…"]);
  eq("duplicate keys on the local side don't multiply rows",
     mergeOutlineRows([r("s1", "t1", "a")], [r("dup", "t1", "a"), r("dup", null, "")], new Set()).length, 1);
}

group("mergeOutlineRows — idempotence (the property that stops runaway growth)");
{
  const scenarios: [string, OutlineRow[], OutlineRow[], Set<string>, string | null, Set<string>][] = [
    ["empty everything", [], [], new Set(), null, new Set()],
    ["server emptied, blank focused", [], [r("mine", null, "")], new Set(), "mine", new Set()],
    ["server emptied, typed row", [], [r("n", null, "text")], new Set(), null, new Set()],
    ["peer appended", [r("s1", "t1", "a"), r("s2", "t2", "b")], [r("k1", "t1", "a"), r("blank", null, "")], new Set(), "blank", new Set()],
    ["mid-list composer", [r("s1", "t1", "a"), r("s2", "t2", "b")], [r("k1", "t1", "a"), r("blank", null, ""), r("k2", "t2", "b")], new Set(), "blank", new Set()],
    ["nested tree + desc", [r("s1", "t1", "p"), r("sd", null, "d", 1, true), r("s2", "t2", "k", 1)], [r("k1", "t1", "p"), r("d1", null, "d", 1, true), r("k2", "t2", "k", 1), r("blank", null, "")], new Set(), "blank", new Set()],
    ["unconfirmed subtask", [r("s1", "t1", "p")], [r("k1", "t1", "p"), r("k2", "t2", "sub", 1)], new Set(["t2"]), "k2", new Set(["t2"])],
    ["unsaved description", [r("s1", "t1", "p")], [r("k1", "t1", "p"), r("d1", null, "typing", 1, true)], new Set(["t1#desc"]), "d1", new Set()],
    ["peer deleted my focused row", [r("s1", "t1", "a")], [r("k1", "t1", "a"), r("k2", "t2", "gone")], new Set(), "k2", new Set()],
    ["everything at once", [r("s1", "t1", "a"), r("s3", "t3", "c", 1)], [r("k1", "t1", "a"), r("n", null, "typed"), r("k2", "t2", "unconfirmed"), r("blank", null, "")], new Set(["t2"]), "blank", new Set(["t2"])],
  ];
  for (const [name, seeded, current, prot, focus, keep] of scenarios) {
    const once = mergeOutlineRows(seeded, current, prot, focus, keep);
    const twice = mergeOutlineRows(seeded, once, prot, focus, keep);
    const thrice = mergeOutlineRows(seeded, twice, prot, focus, keep);
    eq(`stable: ${name}`, JSON.stringify([twice, thrice]), JSON.stringify([once, once]));
  }
  // The runaway Ben actually saw: a peer wipes the list while my blank row is
  // focused, and every refresh re-ran the merge.
  let rows: OutlineRow[] = [r("mine", null, "")];
  const counts = new Set<number>();
  for (let i = 0; i < 50; i++) {
    rows = mergeOutlineRows([], rows, new Set(), "mine");
    counts.add(rows.length);
  }
  eq("50 merges over an emptied list never grow", [...counts], [1]);
  eq("…and it is still my row", keys(rows), ["mine"]);
}

group("mergeOutlineRows — scale sanity");
{
  const seeded: OutlineRow[] = [];
  const current: OutlineRow[] = [];
  for (let i = 0; i < 300; i++) {
    seeded.push(r(`s${i}`, `t${i}`, `task ${i}`, i % 3));
    current.push(r(`k${i}`, `t${i}`, `task ${i}`, i % 3));
  }
  current.push(r("blank", null, ""));
  const t0 = process.hrtime.bigint();
  const merged = mergeOutlineRows(seeded, current, new Set(), "blank");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  eq("300 rows merge to 301 (all rows + my composer)", merged.length, 301);
  eq("…keeping local keys", merged[0].key, "k0");
  eq("…in under 50ms", ms < 50, true);
}

/* ------------------------- the op log's own rules ------------------------ */

group("delete ops must carry their subtree (or the server promotes it to root)");
{
  /** Mirrors `noteDeleted`: which descendants need re-parenting after a line dies. */
  const subtree = (rows: OutlineRow[], deletedIndent: number, from: number) => {
    const out: string[] = [];
    for (let i = from; i < rows.length; i++) {
      const row = rows[i];
      if (!row.desc && row.indent <= deletedIndent) break;
      if (!row.desc && row.taskId) out.push(row.taskId);
    }
    return out;
  };
  // Backspace-merge on a row at indent 1 whose children were c and d: the row is
  // spliced out, so its subtree starts where it was.
  const merged = [r("a", "a", "A"), r("c", "c", "C", 2), r("d", "d", "D", 2), r("e", "e", "E", 1), r("f", "f", "F")];
  eq("children of the deleted row are collected", subtree(merged, 1, 1), ["c", "d"]);
  eq("collection stops at the next sibling", subtree(merged, 1, 1).includes("e"), false);
  eq("each child re-parents to the enclosing task", parentRowAt(merged, 1)?.taskId, "a");
  eq("a leaf delete collects nothing", subtree([r("a", "a", "A"), r("b", "b", "B")], 0, 1), []);
  eq("grandchildren come too", subtree([r("a", "a", "A"), r("c", "c", "C", 2), r("g", "g", "G", 3), r("z", "z", "Z")], 1, 1), ["c", "g"]);
  // Tab→description: the row survives as a desc row, so the subtree starts after it.
  const asDesc = [r("a", "a", "A"), r("d", null, "was a task", 1, true), r("c", "c", "C", 2), r("z", "z", "Z")];
  eq("desc conversion collects the children", subtree(asDesc, 1, 2), ["c"]);
  eq("…and they re-parent past the desc row", parentRowAt(asDesc, 2)?.taskId, "a");
  eq("desc rows are never collected as tasks", subtree([r("a", "a", "A"), r("d", null, "x", 1, true)], 0, 1), []);
}

group("the move pass needs the positions it just wrote");
{
  const rows = [r("ka", "a", "A"), r("kc", "c", "C", 2), r("kd", "d", "D", 2), r("kf", "f", "F")];
  const dbPos: Record<string, number> = { a: 0, f: 5 };
  // WITH the local cache (what `localPosRef` does): sequential, distinct.
  const local = new Map<string, number>();
  const got: number[] = [];
  for (const id of ["c", "d"]) {
    const i = rows.findIndex((x) => x.taskId === id);
    const p = siblingPositionAt(rows, i, (q) => local.get(q) ?? dbPos[q]);
    local.set(id, p);
    got.push(p);
  }
  eq("re-parented children get distinct, ordered positions", got, [0, 1]);
  eq("WITHOUT the cache they collide — why it exists",
     ["c", "d"].map((id) => siblingPositionAt(rows, rows.findIndex((x) => x.taskId === id), (q) => dbPos[q])),
     [0, 0]);
  eq("a new row after a just-created one sits after it",
     siblingPositionAt(
       [r("k1", "a", "A"), r("k2", "new1", "N1"), r("k3", null, "N2")],
       2,
       (id) => (id === "new1" ? 1 : dbPos[id]),
     ), 2);
}

/* ------------------- structural keys → rows → op payload ----------------- */

/* The layer between the row math and the database. It used to live inside
 * `onRowKeyDown`, reachable only through a real keystroke on a mounted textarea,
 * so NOTHING checked what Shift+Tab does to the list or what the create op ends
 * up carrying — which is the seam TD2-188 slipped through. */

/** How a RowEdit reads: the rendered rows, plus where the caret ended up. */
const editView = (edit: RowEdit | null) =>
  edit && [...view(edit.rows), `caret → ${edit.rows.find((r) => r.key === edit.focus.key)?.text ?? "?"}@${edit.focus.caret}`];

group("popDescLine — Shift+Tab pops the caret's line out as a subtask");
{
  // The reported list: a task, its description, three subtasks.
  const base = () => [
    r("kt", "t", "New task here"),
    r("kd", null, "desc", 1, true),
    r("ka", "a", "sous task", 1),
    r("kb", "b", "subtask", 1),
  ];
  const one = popDescLine(base(), 1, 4);
  eq("a one-line description becomes the bullet, in place", editView(one), [
    "New task here",
    "  desc",
    "  sous task",
    "  subtask",
    "caret → desc@4",
  ]);
  eq("the bullet is a TASK row, unbound, at the description's own indent",
     one && [one.rows[1].desc, one.rows[1].taskId, one.rows[1].indent], [false, null, 1]);
  eq("nothing is left to persist — the desc row is gone", one?.persist, []);
  eq("…so the owner's description is written directly, and is now empty",
     one && [one.descOwner, foldedDescriptionFor(one.rows, one.descOwner!)], [0, ""]);
  eq("a create is pumped for the new bullet", one?.creates, true);
  eq("no task moved and none was deleted",
     one && ["movedId" in one, !!one.deleted], [false, false]);

  // Caret in the MIDDLE of a three-line block: lines above stay the
  // description, lines below become the new bullet's own description.
  const block = [
    r("kt", "t", "New task here"),
    r("kd", null, "first\nsecond\nthird", 1, true),
    r("ka", "a", "sous task", 1),
  ];
  const mid = popDescLine(block, 1, "first\nsec".length);
  eq("the caret's line pops, above stays, below follows it", editView(mid), [
    "New task here",
    "  // first",
    "  second",
    "    // third",
    "  sous task",
    "caret → second@6",
  ]);
  eq("the surviving desc row is re-persisted (it lost a line)", mid?.persist, [1]);
  eq("…and the owner keeps only the lines above",
     mid && foldedDescriptionFor(mid.rows, 0), "first");
  eq("the trailing lines belong to the BULLET now, not the owner",
     mid && foldedDescriptionFor(mid.rows, 2), "third");

  eq("the caret on the FIRST line of a block leaves nothing above",
     editView(popDescLine(block, 1, 0)),
     ["New task here", "  first", "    // second\nthird", "  sous task", "caret → first@5"]);
  eq("the caret on the LAST line leaves nothing below",
     editView(popDescLine(block, 1, "first\nsecond\nthi".length)),
     ["New task here", "  // first\nsecond", "  third", "  sous task", "caret → third@5"]);
  eq("an out-of-range caret is clamped, not NaN",
     popDescLine(block, 1, 999)?.focus.caret, 5);
  eq("a whitespace-only remainder is dropped, not kept as an empty desc",
     popDescLine([r("kt", "t", "T"), r("kd", null, "line\n   ", 1, true)], 1, 0)?.rows.length, 2);
  eq("it refuses a row that isn't a description", popDescLine(base(), 0, 0), null);
}

group("retabRow — Tab cycles a task row's role");
{
  // A row may only nest one level below the row above it — you cannot skip a
  // level, so what Tab does depends entirely on the line before.
  const rows = [
    r("kt", "t", "New task here"),
    r("ka", "a", "sous task", 1),
    r("kb", "b", "subtask", 1),
    r("kr", "r", "another root"),
  ];
  eq("the first line has nothing to nest under", maxTaskIndentAt(rows, 0), -1);
  eq("…so Tab means nothing there", retabRow(rows, 0, { shift: false, caret: 0 }), null);
  eq("a row may go one deeper than the row above it", maxTaskIndentAt(rows, 2), 2);
  eq("Tab nests under the sibling above", editView(retabRow(rows, 2, { shift: false, caret: 3 })),
     ["New task here", "  sous task", "    subtask", "another root", "caret → subtask@3"]);
  eq("…and says the task moved", retabRow(rows, 2, { shift: false, caret: 0 })?.movedId, "b");
  eq("Shift+Tab outdents", editView(retabRow(rows, 2, { shift: true, caret: 0 })),
     ["New task here", "  sous task", "subtask", "another root", "caret → subtask@0"]);
  eq("Shift+Tab at the left edge does nothing",
     retabRow(rows, 3, { shift: true, caret: 0 })?.movedId ?? "no edit", "no edit");
  eq("Tab on a row already as deep as the line above allows is NOT a nest",
     retabRow(rows, 1, { shift: false, caret: 0 })?.rows[1].desc, true);
  // Already as deep as allowed: the line stops being a task and joins the
  // description of the task above — a DELETE, and the subtree it leaves behind
  // has to be re-parented.
  const nested = [r("kt", "t", "New task here"), r("ka", "a", "sous task", 1), r("kb", "b", "deep", 2)];
  const deep = retabRow(nested, 2, { shift: false, caret: 0 });
  eq("Tab past the deepest role turns the line into a description",
     editView(deep), ["New task here", "  sous task", "    // deep", "caret → deep@0"]);
  eq("…the row is unbound and its task deleted",
     deep && [deep.rows[2].taskId, deep.deleted?.taskId], [null, "b"]);
  eq("…with the subtree to re-parent named", deep?.deleted, { taskId: "b", indent: 2, from: 3 });
  eq("…and the new desc row is re-persisted onto its owner", deep?.persist, [2]);
  eq("it refuses a description row", retabRow([r("kd", null, "d", 1, true)], 0, { shift: false, caret: 0 }), null);
}

group("splitRow / mergeIntoPrevious — Enter and Backspace");
{
  const rows = [r("kt", "t", "New task here"), r("ka", "a", "sous task", 1)];
  const split = splitRow(rows, 1, 5);
  eq("Enter splits at the caret into a sibling", editView(split),
     ["New task here", "  sous ", "  task", "caret → task@0"]);
  eq("the head keeps the task id, the tail is new",
     split && [split.rows[1].taskId, split.rows[2].taskId], ["a", null]);
  eq("the head's title is re-persisted and a create is pumped",
     split && [split.persist, split.creates], [[1], true]);
  eq("Enter at the end opens an empty line", splitRow(rows, 1, 99)?.rows[2].text, "");

  const merged = mergeIntoPrevious(rows, 1);
  eq("Backspace at offset 0 merges into the row above", editView(merged),
     ["New task heresous task", "caret → New task heresous task@13"]);
  eq("…the merged-away task is deleted, with its subtree named",
     merged?.deleted, { taskId: "a", indent: 1, from: 1 });
  eq("…and the surviving row is re-persisted", merged?.persist, [0]);
  eq("there is nothing above the first row", mergeIntoPrevious(rows, 0), null);
}

group("createOpFor — the op that carries WHERE the line was opened (TD2-188)");
{
  const pos: Record<string, number> = { t: 1, a: 2, b: 3, c: 4 };
  const opts = {
    boardId: "board-1",
    positionOf: (id: string) => pos[id],
    rootTarget: { canvasSectionId: "section-1" },
  };
  // Drive the ACTUAL keystroke, then read the payload it leads to — the two ends
  // of the seam, in one assertion.
  const popped = popDescLine(
    [
      r("kt", "t", "New task here"),
      r("kd", null, "desc", 1, true),
      r("ka", "a", "sous task", 1),
      r("kb", "b", "subtask", 1),
      r("kc", "c", "sub", 1),
    ],
    1,
    4,
  )!;
  eq("a popped description line creates a FIRST subtask, keyed before its siblings",
     createOpFor(popped.rows, 1, opts)?.input,
     { title: "desc", description: undefined, boardId: "board-1", parentId: "t", position: 1 });
  eq("…and it is the row the caret is in", popped.rows[1].key, popped.focus.key);
  eq("a subtask does NOT carry the root pin — it inherits its parent's",
     Object.keys(createOpFor(popped.rows, 1, opts)!.input).includes("canvasSectionId"), false);

  const root = [r("kn", null, "typed at the top"), r("kt", "t", "New task here")];
  eq("a ROOT line carries the pin/bucket, and a key before the first root",
     createOpFor(root, 0, opts)?.input,
     {
       title: "typed at the top",
       description: undefined,
       boardId: "board-1",
       parentId: undefined,
       position: 0,
       canvasSectionId: "section-1",
     });

  eq("the description rows under a new line ride along on the create",
     createOpFor(
       [r("kn", null, "new task"), r("kd1", null, "line one", 1, true), r("kd2", null, "line two", 1, true)],
       0,
       opts,
     )?.input.description,
     "line one\nline two");
  eq("a blank line has nothing to create", createOpFor([r("kn", null, "   ")], 0, opts), null);
  eq("a description row is never a create", createOpFor([r("kd", null, "d", 0, true)], 0, opts), null);

  // An Enter split mid-list asks for the midpoint, through the same path.
  const split = splitRow(
    [r("kt", "t", "T"), r("ka", "a", "AB", 1), r("kb", "b", "B", 1)],
    1,
    1,
  )!;
  eq("an Enter split keys the tail between its neighbours",
     createOpFor(split.rows, 2, opts)?.input.position, 2.5);
}

group("nextCreatableIndex — a child waits for its parent's id");
{
  const none = () => false;
  eq("the first unbound row with text wins",
     nextCreatableIndex([r("kt", "t", "T"), r("kn", null, "new"), r("kn2", null, "later")], none), 1);
  eq("a blank row is not a create", nextCreatableIndex([r("kn", null, "   ")], none), -1);
  eq("a description row is not a create", nextCreatableIndex([r("kd", null, "d", 0, true)], none), -1);
  eq("a child of an unbound parent waits — the parent goes first",
     nextCreatableIndex([r("kp", null, "parent"), r("kc", null, "child", 1)], none), 0);
  eq("…and once the parent is claimed, the child is still not next",
     nextCreatableIndex(
       [r("kp", null, "parent"), r("kc", null, "child", 1)],
       (row) => row.key === "kp",
     ), -1);
  eq("a child of a BOUND parent goes immediately",
     nextCreatableIndex([r("kp", "p", "parent"), r("kc", null, "child", 1)], none), 1);
  eq("nothing to do", nextCreatableIndex([r("kt", "t", "T")], none), -1);
}

group("moveOpFor — a move states its parent AND its position");
{
  const pos: Record<string, number> = { t: 1, a: 2, b: 3 };
  const positionOf = (id: string) => pos[id];
  const rows = [r("kt", "t", "T"), r("ka", "a", "A", 1), r("kb", "b", "B", 1)];
  eq("a nested row moves under its new parent, keyed after its sibling",
     moveOpFor(rows, 2, positionOf), { op: "move", id: "b", target: { parentId: "t", position: 3 } });
  const out = retabRow(rows, 2, { shift: true, caret: 0 })!;
  eq("Shift+Tab to root moves it to the root group",
     moveOpFor(out.rows, 2, positionOf), { op: "move", id: "b", target: { parentId: null, position: 2 } });
  eq("an unbound row has no move op", moveOpFor([r("kn", null, "new")], 0, positionOf), null);
  eq("a description row has no move op", moveOpFor([r("kd", null, "d", 0, true)], 0, positionOf), null);
}

/* -------------------------------- locking ------------------------------- */

group("resolveRowLock — ownership from presence alone");
{
  const NOW = 1_000_000;
  const c = (
    id: number,
    name: string,
    field: string,
    since: number,
    typingAt = since,
    override?: string,
  ): RowClaim => ({ id, name, color: `#${id}`, field, since, typingAt, override });

  eq("nobody in the row", resolveRowLock("t1", [], 1, NOW).state, "free");
  eq("no field at all", resolveRowLock(null, [c(2, "B", "t1", NOW)], 1, NOW).state, "free");
  eq("claims on other rows are irrelevant", resolveRowLock("t2", [c(2, "B", "t1", NOW)], 1, NOW).state, "free");
  eq("a title lock does not lock the description",
     resolveRowLock("t1#desc", [c(2, "B", "t1", NOW)], 1, NOW).state, "free");
  eq("only me → mine, nobody waiting",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW)], 1, NOW), { state: "mine", waiting: [] });

  const both = [c(1, "Me", "t1", NOW - 5000, NOW), c(2, "Ben", "t1", NOW - 1000, NOW)];
  eq("earliest claim owns it", resolveRowLock("t1", both, 1, NOW).state, "mine");
  eq("…and names who is waiting",
     (resolveRowLock("t1", both, 1, NOW) as { waiting: { name: string }[] }).waiting.map((w) => w.name),
     ["Ben"]);
  eq("the later arrival sees a live peer lock",
     resolveRowLock("t1", both, 2, NOW), { state: "peer", owner: { name: "Me", color: "#1" }, live: true });
  eq("a third party names the same owner",
     (resolveRowLock("t1", both, 9, NOW) as { owner: { name: string } }).owner.name, "Me");

  eq("three claimants: two waiting",
     (resolveRowLock("t1", [...both, c(3, "C", "t1", NOW)], 1, NOW) as { waiting: unknown[] }).waiting.length, 2);

  // Live vs parked.
  eq("idle beyond PARK_MS → parked (takeable by typing)",
     resolveRowLock("t1", [c(2, "B", "t1", NOW - 9000, NOW - PARK_MS - 1)], 1, NOW),
     { state: "peer", owner: { name: "B", color: "#2" }, live: false });
  eq("exactly at the boundary counts as live",
     (resolveRowLock("t1", [c(2, "B", "t1", NOW, NOW - PARK_MS)], 1, NOW) as { live: boolean }).live, true);
  eq("a clock ahead of ours is live, not parked",
     (resolveRowLock("t1", [c(2, "B", "t1", NOW, NOW + 5000)], 1, NOW) as { live: boolean }).live, true);
  eq("MY parked claim is still mine (live only matters for peers)",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW - 60_000, NOW - 60_000)], 1, NOW).state, "mine");
  eq("a peer who never typed is parked from the start",
     (resolveRowLock("t1", [c(2, "B", "t1", NOW, 0)], 1, NOW) as { live: boolean }).live, false);

  // Takeover.
  eq("an override beats seniority",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW - 5000, NOW), c(2, "Ben", "t1", NOW - 100, NOW, "t1")], 1, NOW),
     { state: "peer", owner: { name: "Ben", color: "#2" }, live: true });
  eq("…and the taker sees it as theirs",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW - 5000, NOW), c(2, "Ben", "t1", NOW - 100, NOW, "t1")], 2, NOW).state,
     "mine");
  eq("an override for another field is ignored here",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW - 5000, NOW), c(2, "B", "t1", NOW, NOW, "t9")], 1, NOW).state,
     "mine");
  eq("two overrides: the latest intent wins",
     (resolveRowLock("t1", [c(1, "A", "t1", NOW - 100, NOW, "t1"), c(2, "B", "t1", NOW - 50, NOW, "t1")], 9, NOW) as {
       owner: { name: string };
     }).owner.name, "B");
  eq("overriding a row I already own is a no-op",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW - 5000, NOW, "t1")], 1, NOW).state, "mine");
  eq("an override on an otherwise free row just claims it",
     resolveRowLock("t1", [c(1, "Me", "t1", NOW, NOW, "t1")], 1, NOW).state, "mine");

  // Determinism.
  const tie = [c(7, "Seven", "t1", NOW - 1000, NOW), c(3, "Three", "t1", NOW - 1000, NOW)];
  eq("identical `since` → lowest connection id owns", resolveRowLock("t1", tie, 3, NOW).state, "mine");
  eq("…the other yields", resolveRowLock("t1", tie, 7, NOW).state, "peer");
  eq("…and every client agrees on the name",
     (resolveRowLock("t1", tie, 9, NOW) as { owner: { name: string } }).owner.name, "Three");
  eq("claim order in the array does not matter",
     JSON.stringify(resolveRowLock("t1", [...tie].reverse(), 9, NOW)),
     JSON.stringify(resolveRowLock("t1", tie, 9, NOW)));
  eq("zero timestamps are still ordered",
     (resolveRowLock("t1", [c(5, "Zero", "t1", 0, 0), c(6, "Later", "t1", NOW, NOW)], 9, NOW) as {
       owner: { name: string };
     }).owner.name, "Zero");
}

/* ------------------------------- takeover ------------------------------- */
// Taking a row means overwriting a field wholesale, so what the taker holds at
// that instant IS what everyone gets. These are the rules that stop a takeover
// deleting the previous owner's last sentence.
{
  group("takeoverText");

  eq("adopts the shared value, not the local snapshot",
     takeoverText("their latest", "my stale copy").text, "their latest");
  eq("…and says it changed", takeoverText("their latest", "my stale copy").changed, true);
  eq("identical text is not a change (nothing is shown to the user)",
     takeoverText("same", "same").changed, false);
  eq("with no keystroke to replay the caret lands at the end",
     takeoverText("their latest", "x").caret, "their latest".length);

  // The parked path: typing IS the takeover, so that character must survive.
  eq("an unchanged line replays the keystroke where it was typed",
     takeoverText("hello world", "hello world", { insert: "X", at: 5 }).text, "helloX world");
  eq("…with the caret after it",
     takeoverText("hello world", "hello world", { insert: "X", at: 5 }).caret, 6);
  eq("a CHANGED line appends instead — an offset into unread text means nothing",
     takeoverText("they rewrote it", "hello world", { insert: "X", at: 5 }).text,
     "they rewrote itX");
  eq("…and the keystroke is never dropped",
     takeoverText("they rewrote it", "hello world", { insert: "X", at: 5 }).text.includes("X"),
     true);
  eq("an offset past the end of their text is clamped, not NaN",
     takeoverText("hi", "hi", { insert: "!", at: 99 }).text, "hi!");
  eq("a negative offset is clamped too",
     takeoverText("hi", "hi", { insert: "!", at: -3 }).text, "!hi");
  eq("adopting an empty field is not a special case",
     takeoverText("", "leftovers", { insert: "a", at: 4 }).text, "a");
}

group("createOpFor — a line typed under an assignee filter (TD2-193)");
{
  const opts = {
    boardId: "board-1",
    positionOf: () => 0,
    rootTarget: { canvasSectionId: "section-1" },
  };
  const rows = [r("kn", null, "typed while filtered")];
  eq("with nobody filtered, the payload is unchanged — no empty field appears",
     Object.keys(createOpFor(rows, 0, opts)!.input).includes("assigneeIds"), false);
  eq("filtered to someone, the create carries them",
     createOpFor(rows, 0, { ...opts, assigneeIds: ["u1"] })?.input.assigneeIds, ["u1"]);
  eq("a SUBTASK line carries them too — it would vanish just as fast",
     createOpFor(
       [r("kt", "t", "parent"), r("kn", null, "child", 1)],
       1,
       { ...opts, assigneeIds: ["u1"] },
     )?.input.assigneeIds,
     ["u1"]);
  eq("an empty list of assignees is not a filter, and adds nothing",
     Object.keys(createOpFor(rows, 0, { ...opts, assigneeIds: [] })!.input).includes("assigneeIds"),
     false);
}

group("hiddenOrphanMoves — deleting a line whose children the filter hid (TD2-194)");
{
  /* p ─ a (shown) · b (hidden by the filter). Deleting p's line must re-parent
     BOTH, or `deleteTask` promotes the hidden one to root at the end. */
  const scope = [
    { id: "p", parentId: null, position: 1 },
    { id: "a", parentId: "p", position: 2 },
    { id: "b", parentId: "p", position: 3 },
  ];
  const posOf = (id: string) => scope.find((n) => n.id === id)?.position;

  eq("the hidden child is re-parented onto the dead line's own parent",
     hiddenOrphanMoves(["p"], new Set(["a"]), scope, posOf),
     [{ op: "move", id: "b", target: { parentId: null, position: 3 } }]);
  eq("the SHOWN child is left alone — the editor's own walk claimed it",
     hiddenOrphanMoves(["p"], new Set(["a"]), scope, posOf).some((m) => m.id === "a"),
     false);
  eq("with nothing filtered there is nothing to fix up",
     hiddenOrphanMoves(["p"], new Set(["a", "b"]), scope, posOf), []);
  eq("a child that is ALSO being deleted is not re-parented onto anything",
     hiddenOrphanMoves(["p", "b"], new Set([]), scope, posOf).some((m) => m.id === "b"),
     false);
  eq("it keeps the position it already had, so it lands where it was",
     hiddenOrphanMoves(["p"], new Set([]), scope, posOf).map((m) => m.target.position),
     [2, 3]);
  eq("a live local position wins over the stale one from the scope",
     hiddenOrphanMoves(["p"], new Set(["a"]), scope, (id) => (id === "b" ? 99 : posOf(id)))[0]
       .target.position,
     99);
  /* g ─ p ─ b: deleting p hands b to g, not to the root. */
  const nested = [
    { id: "g", parentId: null, position: 1 },
    { id: "p", parentId: "g", position: 2 },
    { id: "b", parentId: "p", position: 3 },
  ];
  eq("a nested line's hidden child goes to the GRANDPARENT, not to root",
     hiddenOrphanMoves(["p"], new Set([]), nested, (id) => nested.find((n) => n.id === id)?.position)[0]
       .target.parentId,
     "g");
}

group("task filters — what a view draws (TD2-216)");
{
  const t = (id: string, assignees: string[], boardId: string | null = "b1") => ({
    taskId: id,
    title: id,
    description: "",
    task: { id, assigneeIds: assignees, boardId },
    children: [] as never[],
  });
  const tree = (parent: ReturnType<typeof t>, kids: ReturnType<typeof t>[]) =>
    ({ ...parent, children: kids }) as unknown as ReturnType<typeof t>;

  const mine = makeTaskPredicate({ assigneeId: "u1" });
  eq("a task assigned to them is kept", mine({ assigneeIds: ["u1"], boardId: "b1" }), true);
  eq("…and one that isn't, is not", mine({ assigneeIds: ["u2"], boardId: "b1" }), false);
  eq("a co-assigned task is theirs too", mine({ assigneeIds: ["u2", "u1"] }), true);

  const onBoard = makeTaskPredicate({ boardIds: ["b1"] });
  eq("a task on a selected board is kept", onBoard({ boardId: "b1" }), true);
  eq("…on another board, it is not", onBoard({ boardId: "b2" }), false);
  eq("a task on NO board is hidden by any narrowing — no selection includes it",
     onBoard({ boardId: null }), false);
  eq("but with nothing narrowed, a board-less task is shown",
     makeTaskPredicate({})({ boardId: null }), true);
  eq("both axes must hold at once",
     makeTaskPredicate({ assigneeId: "u1", boardIds: ["b1"] })({
       assigneeIds: ["u1"],
       boardId: "b2",
     }),
     false);

  const units = [
    tree(t("p", ["u2"]), [t("c", ["u1"])]),
    t("solo", ["u2"]),
  ] as unknown as Parameters<typeof filterUnits>[0];
  const kept = filterUnits(units, mine);
  eq("a parent survives on its child's account — an orphaned match reads as a lie",
     kept.map((u) => u.taskId), ["p"]);
  eq("…and the matching child is still under it", kept[0].children.map((c) => c.taskId), ["c"]);
  eq("a filter that keeps everything hands back the SAME array (memo identity)",
     filterUnits(units, NO_FILTER.keep) === units, true);

  /* The node-shaped twin: the project views hold a flat list plus a lookup. */
  const nodes = [
    { id: "p", parentId: null },
    { id: "c", parentId: "p" },
    { id: "solo", parentId: null },
  ];
  const tasks: Record<string, { assigneeIds: string[] }> = {
    p: { assigneeIds: ["u2"] },
    c: { assigneeIds: ["u1"] },
    solo: { assigneeIds: ["u2"] },
  };
  const match = makeNodeMatcher({
    keep: mine,
    taskOf: (id) => tasks[id],
    childrenOf: (id) => nodes.filter((n) => n.parentId === id),
  });
  eq("a node with a matching descendant is drawn", match("p"), true);
  eq("the match itself is drawn", match("c"), true);
  eq("a node with no match anywhere below is not", match("solo"), false);

  const cyclic = [
    { id: "x", parentId: "y" },
    { id: "y", parentId: "x" },
  ];
  eq("a corrupt parent cycle answers false instead of recursing forever",
     makeNodeMatcher({
       keep: mine,
       taskOf: () => ({ assigneeIds: ["u2"] }),
       childrenOf: (id) => cyclic.filter((n) => n.parentId === id),
     })("x"),
     false);

  eq("the canvas filter hides a lane whose board nobody selected",
     makeRenderFilter({ boardIds: ["b1"] }).showsBoard("b2"), false);
  eq("…and draws one whose board is selected",
     makeRenderFilter({ boardIds: ["b1"] }).showsBoard("b1"), true);
  eq("the No-board lane goes with any narrowing",
     makeRenderFilter({ boardIds: ["b1"] }).showsBoard(null), false);
  eq("an assignee-only filter leaves every LANE standing — it prunes cards",
     makeRenderFilter({ assigneeId: "u1" }).showsBoard("b2"), true);
  eq("nothing narrowed is the shared no-filter object, so memo boundaries hold",
     makeRenderFilter({}) === NO_FILTER, true);
  eq("…and it is not marked active", NO_FILTER.active, false);
}

/* -------------------------------- summary ------------------------------- */

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n\n${failures.join("\n\n")}\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);
process.exit(failures.length ? 1 : 0);
