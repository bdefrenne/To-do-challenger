/*
  TASK ORDER CHECK — the ordering rule and the reorder math, in isolation.

  Two bugs came out of this one area. `position` is minted per (status, parent)
  and never renumbered, so any view mixing statuses — a canvas Section, an INBOX
  lane — holds ties. Ordering on `position` alone left those ties to Postgres's
  scan order, so deleting one card re-permuted cards nobody touched (TD-40). And
  a reorder interpolated a midpoint between its new neighbours, which for two
  tied neighbours IS their position, so the card landed by tiebreak instead of
  where it was dropped (TD-42).

  What this guards is the pair of invariants those fixes rest on: the order is
  TOTAL (no input permutation changes the result), and a drop lands the card at
  exactly the index it was dropped at — including inside a run that is entirely
  tied, and repeatedly, without the precision decay the old midpoint math had.

  Pure logic, no DB.

    npm run check:order
*/

import { compareTaskOrder, insertRelative } from "../src/lib/task-order";

type N = { id: string; position: number; createdAt: string };
const t = (id: string, position: number, createdAt: string): N => ({ id, position, createdAt });

let failures = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        want ${JSON.stringify(want)}`);
    console.log(`        got  ${JSON.stringify(got)}`);
  }
};

/** What moveNode does: sort the run, reorder, restamp dense, re-sort. */
const drop = (run: N[], dragId: string, targetId: string, pos: "before" | "after") => {
  const sorted = [...run].sort(compareTaskOrder);
  const ordered = insertRelative(sorted.map((n) => n.id), dragId, targetId, pos);
  const posById = new Map(ordered.map((id, i) => [id, i]));
  const after = run.map((n) => ({ ...n, position: posById.get(n.id) ?? n.position }));
  return [...after].sort(compareTaskOrder).map((n) => n.id);
};

// ---- The tie run that started this: 6 cards all on position 14. ----
const tied = [
  t("a", 14, "2026-01-01"),
  t("b", 14, "2026-01-02"),
  t("c", 14, "2026-01-03"),
  t("d", 14, "2026-01-04"),
  t("e", 14, "2026-01-05"),
];
check("tied run renders in createdAt order", [...tied].sort(compareTaskOrder).map((n) => n.id), [
  "a", "b", "c", "d", "e",
]);
check("drop e before a (all tied)", drop(tied, "e", "a", "before"), ["e", "a", "b", "c", "d"]);
check("drop a after e (all tied)", drop(tied, "a", "e", "after"), ["b", "c", "d", "e", "a"]);
check("drop a before d (all tied)", drop(tied, "a", "d", "before"), ["b", "c", "a", "d", "e"]);
check("drop c after c is a no-op", drop(tied, "c", "c", "after"), ["a", "b", "c", "d", "e"]);

// ---- Sparse/mixed run, the normal case ----
const sparse = [
  t("p", 0, "2026-02-01"),
  t("q", 6, "2026-02-02"),
  t("r", 6, "2026-02-03"),
  t("s", 48, "2026-02-04"),
];
check("mixed run baseline", [...sparse].sort(compareTaskOrder).map((n) => n.id), ["p", "q", "r", "s"]);
check("drop s between q and r", drop(sparse, "s", "r", "before"), ["p", "q", "s", "r"]);
check("drop p to the end", drop(sparse, "p", "s", "after"), ["q", "r", "s", "p"]);

// ---- Card from outside the run (cross-parent / cross-status drop) ----
const withOutsider = [...sparse];
check(
  "outsider inserted before q",
  drop([...withOutsider, t("z", 999, "2026-03-01")], "z", "q", "before"),
  ["p", "z", "q", "r", "s"],
);

// ---- Target not in the run -> append, never an arbitrary index ----
check(
  "missing target appends",
  insertRelative(["p", "q", "r"], "p", "nope", "before"),
  ["q", "r", "p"],
);

// ---- Idempotence: restamping twice changes nothing further ----
const once = drop(tied, "e", "a", "before");
const dense = once.map((id, i) => t(id, i, `2026-01-0${i + 1}`));
check("second identical drop is stable", drop(dense, "e", "a", "before"), once);

// ---- Repeated inserts stay exact (the old midpoint decayed toward precision loss) ----
let run = [t("x", 0, "2026-04-01"), t("y", 1, "2026-04-02"), t("m", 2, "2026-04-03")];
for (let i = 0; i < 60; i++) {
  const order = drop(run, "m", "y", "before");
  run = order.map((id, idx) => ({ ...run.find((n) => n.id === id)!, position: idx }));
  const order2 = drop(run, "m", "y", "after");
  run = order2.map((id, idx) => ({ ...run.find((n) => n.id === id)!, position: idx }));
}
check("60 insert cycles keep integer positions", run.map((n) => n.position), [0, 1, 2]);
check("60 insert cycles keep the intended order", run.map((n) => n.id), ["x", "y", "m"]);

// ---- TD-40: the order must be TOTAL, i.e. independent of input order. ----
// This is the property that stops a delete from re-permuting untouched cards:
// if any shuffle of the input can change the output, the row order Postgres
// happens to return still leaks through.
const pool = [
  t("k1", 14, "2026-05-01"),
  t("k2", 14, "2026-05-02"),
  t("k3", 14, "2026-05-02"), // same position AND same createdAt — id decides
  t("k4", 0, "2026-05-03"),
  t("k5", 48, "2026-05-04"),
];
const canonical = [...pool].sort(compareTaskOrder).map((n) => n.id);
let permutationsAgree = true;
for (let i = 0; i < 200; i++) {
  // Deterministic shuffle (no Math.random — this has to be reproducible).
  const shuffled = [...pool].sort(
    (a, b) => ((a.id.charCodeAt(1) * (i + 7)) % 11) - ((b.id.charCodeAt(1) * (i + 7)) % 11),
  );
  if ([...shuffled].sort(compareTaskOrder).map((n) => n.id).join() !== canonical.join())
    permutationsAgree = false;
}
check("order is total (200 input permutations agree)", permutationsAgree, true);

// And deleting any single card must not reorder the survivors.
let survivorsHold = true;
for (const victim of pool.map((n) => n.id)) {
  const want = canonical.filter((id) => id !== victim);
  const got = pool.filter((n) => n.id !== victim).sort(compareTaskOrder).map((n) => n.id);
  if (want.join() !== got.join()) survivorsHold = false;
}
check("deleting any one card leaves survivor order intact", survivorsHold, true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
