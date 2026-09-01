/*
  ACTIVITY FEED CHECK (TD2-211) — proves the two things a log must not get
  wrong, against the real database.

  1. **A call is recorded, with its arguments shrunk.** `recordMcpCall` is
     fire-and-forget by design (a failed insert must never cost the user their
     tool call), which means nothing upstream ever sees it fail — so the only
     place the write is provably reaching Postgres is here. Also guarded: a
     20k-char argument is clipped before it lands, since the whole point of a
     call log is that it stays smaller than the data it describes.

  2. **The merge interleaves both streams by time.** `activityFeed` reads two
     independently-limited queries and sorts them together; the failure mode is
     one stream silently dominating the page, which no type checks and no single
     -stream test can catch.

  Makes its own scratch task + call rows and PURGES them (a soft delete would
  leave residue in the Trash — see the convention in CLAUDE.md).

    npm run check:activity
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, inArray, like } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { mcpCalls, tasks, users } from "../src/lib/db/schema";
import { recordMcpCall } from "../src/lib/db/mcp-log";
import { withLogContext } from "../src/lib/db/log-context";
import {
  activityFeed,
  mcpCallStats,
  createTask,
  addComment,
  purgeTask,
  deleteTask,
  listProjects,
} from "../src/lib/db/service";

const AUTHOR = "check:activity";
const TITLE = "[check:activity] scratch — safe to delete";
const TOOL = "__check_activity_tool";

let pass = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The recorder is fire-and-forget: it returns before the insert lands, so a
 *  check has to wait for the row rather than assume it. */
async function waitForCall(name: string, tries = 40): Promise<typeof mcpCalls.$inferSelect | null> {
  for (let i = 0; i < tries; i++) {
    const [row] = await db.select().from(mcpCalls).where(eq(mcpCalls.name, name)).limit(1);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  const [me] = await db.select().from(users).limit(1);
  if (!me) throw new Error("no users in the database");
  const projects = await listProjects(me.id);
  const board = projects.flatMap((p) => p.boards ?? [])[0];
  if (!board) throw new Error("no boards in the database");

  console.log("\nrecordMcpCall");
  recordMcpCall({
    userId: me.id,
    kind: "tool",
    name: TOOL,
    args: { text: "x".repeat(20000), ids: Array.from({ length: 50 }, (_, i) => `id-${i}`) },
    ok: true,
    durationMs: 42,
    resultBytes: 1234,
  });
  const row = await waitForCall(TOOL);
  check("the call reaches Postgres", !!row);
  if (row) {
    check("duration + size are stored", row.durationMs === 42 && row.resultBytes === 1234);
    check("the surface defaults to mcp", row.surface === "mcp");
    const args = row.args as { text?: string; ids?: unknown[] } | null;
    check(
      "a 20k-char argument is clipped, not stored whole",
      !!args?.text && args.text.length < 600,
      `got ${args?.text?.length ?? 0} chars`,
    );
    check(
      "a 50-item array is summarized",
      Array.isArray(args?.ids) && args!.ids!.length <= 21,
      `got ${(args?.ids as unknown[])?.length}`,
    );
  }

  console.log("\na failing call is still recorded");
  recordMcpCall({
    userId: me.id,
    kind: "tool",
    name: `${TOOL}_fail`,
    args: null,
    ok: false,
    error: "boom",
    durationMs: 1,
  });
  const failRow = await waitForCall(`${TOOL}_fail`);
  check("the failure is in the log", !!failRow && failRow.ok === false);
  check("its error message is kept", failRow?.error === "boom");

  console.log("\nthe merged feed");
  // A real task change, written through the service the way any surface does.
  const created = await withLogContext({ actorId: me.id, source: "ui" }, () =>
    createTask({ title: TITLE, boardId: board.id }, me.id, AUTHOR),
  );
  await withLogContext({ actorId: me.id, source: "ui" }, () =>
    addComment(created.id, "check:activity comment", me.id, AUTHOR),
  );

  const feed = await activityFeed(me.id, { limit: 400 });
  const mine = feed.filter(
    (e) =>
      (e.kind === "task" && e.taskId === created.id) ||
      (e.kind === "call" && e.name.startsWith(TOOL)),
  );
  check("both streams appear in one feed", new Set(mine.map((e) => e.kind)).size === 2);
  check(
    "the task entry carries its task's title",
    mine.some((e) => e.kind === "task" && e.taskTitle === TITLE),
  );
  check(
    "the call entry carries its arguments",
    mine.some((e) => e.kind === "call" && e.name === TOOL && !!e.args),
  );
  const times = feed.map((e) => e.at);
  check(
    "the feed is newest-first across BOTH streams",
    times.every((t, i) => i === 0 || times[i - 1] >= t),
  );

  console.log("\nfilters");
  const callsOnly = await activityFeed(me.id, { streams: ["call"], limit: 50 });
  check("streams:['call'] drops the task stream", callsOnly.every((e) => e.kind === "call"));
  const tasksOnly = await activityFeed(me.id, { streams: ["task"], limit: 50 });
  check("streams:['task'] drops the call stream", tasksOnly.every((e) => e.kind === "task"));
  const byActor = await activityFeed(me.id, { actor: me.id, limit: 50 });
  check("an actor filter keeps only that actor", byActor.every((e) => e.actorId === me.id));
  const noReads = await activityFeed(me.id, { writesOnly: true, streams: ["call"], limit: 200 });
  check(
    "writesOnly drops the read-only tools",
    !noReads.some((e) => e.kind === "call" && e.name === "list_tasks"),
  );

  console.log("\nstats");
  const stats = await mcpCallStats(me.id, {});
  const mineStat = stats.find((s) => s.name === TOOL);
  check("the tool is counted", !!mineStat && mineStat.calls >= 1);
  check("failures are counted separately", stats.find((s) => s.name === `${TOOL}_fail`)?.failures === 1);

  // ---- cleanup: PURGE, never a soft delete (the Trash is not a bin for tests)
  await deleteTask(created.id, me.id, AUTHOR);
  await purgeTask(created.id, me.id);
  await db.delete(mcpCalls).where(like(mcpCalls.name, `${TOOL}%`));
  const leftovers = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, TITLE));
  check("scratch task is purged", leftovers.length === 0);
  const leftCalls = await db.select({ id: mcpCalls.id }).from(mcpCalls).where(like(mcpCalls.name, `${TOOL}%`));
  check("scratch call rows are gone", leftCalls.length === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
