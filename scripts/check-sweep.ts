/**
 * "Clear Done" checks — what a sweep names, and how long a filed card's
 * requested bucket is allowed to show (TD2-218).
 *
 * `npm run check:sweep`
 *
 * Two pure rules, both load-bearing in a way that doesn't render oddly when it's
 * wrong:
 *
 *   • `sweepableDoneIds` decides which cards a sweep MOVES. Name a child that
 *     was riding along on its parent's placement and you weld it to a lane it
 *     was never filed into; fail to name one that carries its own pin and you
 *     leave finished work behind in a band you just told someone was cleared.
 *   • `placementOverrideSettled` decides how long a card is drawn in the bucket
 *     it was filed into before the server's answer takes over. Drop it too early
 *     — which is what "as soon as the request returns" did — and clearing a
 *     second column a second later makes the first column's cards reappear in
 *     the band they just left; never drop it and a refused write is invisible.
 *
 * Pure functions only: no database, no network, no React.
 */

import { sweepableDoneIds, type SweepNode } from "@/lib/sweep";
import { placementOverrideSettled } from "@/lib/sections";
import type { TaskStatus } from "@/lib/types";

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
    failures.push(`${section} › ${name}\n    got:  ${g}\n    want: ${w}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
  }
};

/* ------------------------------ the cards ------------------------------ */

const node = (
  id: string,
  status: TaskStatus,
  boardId: string | null,
  parentId: string | null = null,
): SweepNode => ({ id, status, boardId, parentId });

/** No card carries a pin unless a test says so. */
const none = () => false;
const pinnedOnly =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

group("what a sweep names");
{
  const cards = [
    node("a", "done", "b1"),
    node("b", "todo", "b1"),
    node("c", "done", "b2"),
    node("d", "done", null),
  ];
  const onBoards = (boards: string[]) => (n: SweepNode) =>
    n.boardId !== null && boards.includes(n.boardId);

  eq("only done cards",
     sweepableDoneIds(cards, { inScope: () => true, pinned: none }),
     ["a", "c", "d"]);
  eq("scope is the caller's — one board",
     sweepableDoneIds(cards, { inScope: onBoards(["b1"]), pinned: none }),
     ["a"]);
  eq("scope is the caller's — the whole project",
     sweepableDoneIds(cards, { inScope: onBoards(["b1", "b2"]), pinned: none }),
     ["a", "c"]);
  eq("nothing in scope names nothing",
     sweepableDoneIds(cards, { inScope: () => false, pinned: none }),
     []);
  eq("input order is kept, so the batch reads like the column",
     sweepableDoneIds(
       [node("z", "done", "b1"), node("y", "done", "b1")],
       { inScope: () => true, pinned: none },
     ),
     ["z", "y"]);
}

group("a done card under a done parent");
{
  const family = [
    node("parent", "done", "b1"),
    node("child", "done", "b1", "parent"),
    node("grandchild", "done", "b1", "child"),
  ];

  eq("an UNPINNED child is not named — it inherits, so it rides along",
     sweepableDoneIds(family, { inScope: () => true, pinned: none }),
     ["parent"]);
  eq("a PINNED child IS named — nothing carries it",
     sweepableDoneIds(family, { inScope: () => true, pinned: pinnedOnly("child") }),
     ["parent", "child"]);
  eq("a pinned grandchild under an unpinned child still gets named",
     sweepableDoneIds(family, { inScope: () => true, pinned: pinnedOnly("grandchild") }),
     ["parent", "grandchild"]);
  eq("a done child of an OPEN parent is named — the parent isn't moving",
     sweepableDoneIds(
       [node("parent", "building", "b1"), node("child", "done", "b1", "parent")],
       { inScope: () => true, pinned: none },
     ),
     ["child"]);
  eq("a done child whose done parent is OUT of scope is named",
     sweepableDoneIds(
       [node("parent", "done", "b2"), node("child", "done", "b1", "parent")],
       { inScope: (n) => n.boardId === "b1", pinned: none },
     ),
     ["child"]);
  eq("a done child of a done parent in ANOTHER band rides along only if unpinned",
     sweepableDoneIds(
       [node("parent", "done", "b1"), node("child", "done", "b1", "parent")],
       { inScope: () => true, pinned: pinnedOnly("parent") },
     ),
     ["parent"]);
}

group("how long a requested bucket shows");
{
  const at = (openedAt: number, quietSince: number | null, resolved: string | null) =>
    placementOverrideSettled({
      asked: "doneThisWeek",
      resolved: resolved as never,
      openedAt,
      quietSince,
    });

  eq("a snapshot that AGREES settles it",
     at(1_000, null, "doneThisWeek"), true);
  eq("a card that has left the board settles it",
     at(1_000, null, null), true);
  eq("a snapshot taken mid-write may confirm but never overrule",
     at(1_000, null, "backlog"), false);
  eq("a quiet snapshot taken AFTER we asked overrules — a refused write snaps back",
     at(1_000, 2_000, "backlog"), true);
  eq("a quiet snapshot taken BEFORE we asked settles nothing",
     at(2_000, 1_000, "backlog"), false);
  eq("…and is still allowed to confirm",
     at(2_000, 1_000, "doneThisWeek"), true);
}

group("the reported bug: two columns cleared a second apart");
{
  // Sweep A at t=0, sweep B at t=1000. B's write defers the reconcile, so the
  // only fetch is the one B's own mutation makes when the board falls quiet.
  const sweepA = 0;
  const sweepB = 1_000;
  const bReconcile = 3_000; // requested with nothing in flight

  eq("A's cards keep showing in the tray while B is still writing",
     placementOverrideSettled({
       asked: "doneThisWeek",
       // The pin A's write produced hasn't been read yet, so the last snapshot
       // still says BACKLOG — this is exactly the state that used to redraw them.
       resolved: "backlog",
       openedAt: sweepA,
       quietSince: null,
     }),
     false);
  eq("B's reconcile settles A as well, by agreeing",
     placementOverrideSettled({
       asked: "doneThisWeek",
       resolved: "doneThisWeek",
       openedAt: sweepA,
       quietSince: bReconcile,
     }),
     true);
  eq("…and settles B",
     placementOverrideSettled({
       asked: "doneThisWeek",
       resolved: "doneThisWeek",
       openedAt: sweepB,
       quietSince: bReconcile,
     }),
     true);
  eq("an op that started AFTER that fetch was asked for is not settled by it",
     placementOverrideSettled({
       asked: "doneThisWeek",
       resolved: "backlog",
       openedAt: bReconcile + 1,
       quietSince: bReconcile,
     }),
     false);
}

/* -------------------------------- summary ------------------------------- */

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n\n${failures.join("\n\n")}\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);
process.exit(failures.length ? 1 : 0);
