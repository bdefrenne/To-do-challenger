/*
  Backfill task codes/refs for existing data. Idempotent and per-user:
    1. Give every user/project/board a unique ≤4-char `code` (derived from the
       name), unique across everything that user owns.
    2. Give every task a `seq` from its owner's counter (board → project →
       user), set `projectId` from its board, and LOCK it (frozen `ref`) —
       existing tasks are already real work.
    3. Advance each owner's `nextSeq` past the max it handed out.

  Safe to run repeatedly (skips tasks that already have a locked ref, and
  owners that already have a code). Run after `npm run db:migrate`:
    npm run db:backfill:refs
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { users, projects, boards, tasks } from "../src/lib/db/schema";
import { deriveCode } from "../src/lib/refs";

/** Pick a code from `name` that isn't already in `taken`; record + return it. */
function pickCode(name: string, taken: Set<string>): string {
  const base = deriveCode(name);
  let cand = base;
  for (let n = 2; taken.has(cand.toUpperCase()); n++) cand = `${base}${n}`.slice(0, 4);
  taken.add(cand.toUpperCase());
  return cand;
}

async function main() {
  const allUsers = await db.select().from(users);
  console.log(`Backfilling refs for ${allUsers.length} user(s)…`);

  for (const u of allUsers) {
    const taken = new Set<string>();

    // 1. User code.
    let userCode = u.code;
    if (userCode) taken.add(userCode.toUpperCase());
    else {
      userCode = pickCode(u.name || "Me", taken);
      await db.update(users).set({ code: userCode }).where(eq(users.id, u.id));
    }

    // 2. Project codes.
    const projectRows = await db
      .select().from(projects).where(eq(projects.userId, u.id));
    const projectCode = new Map<string, string>();
    for (const p of projectRows) {
      let code = p.code;
      if (code) taken.add(code.toUpperCase());
      else {
        code = pickCode(p.name, taken);
        await db.update(projects).set({ code }).where(eq(projects.id, p.id));
      }
      projectCode.set(p.id, code);
    }

    // 3. Board codes.
    const boardRows = await db
      .select().from(boards).where(eq(boards.userId, u.id));
    const boardCode = new Map<string, string>();
    const boardProject = new Map<string, string>();
    for (const b of boardRows) {
      let code = b.code;
      if (code) taken.add(code.toUpperCase());
      else {
        code = pickCode(b.name, taken);
        await db.update(boards).set({ code }).where(eq(boards.id, b.id));
      }
      boardCode.set(b.id, code);
      boardProject.set(b.id, b.projectId);
    }

    // 4. Tasks — assign seq per owner (createdAt order) + lock.
    const taskRows = await db
      .select().from(tasks).where(eq(tasks.userId, u.id)).orderBy(asc(tasks.createdAt));

    // Per-owner running counter (keyed "board:<id>" / "project:<id>" / "user").
    const counter = new Map<string, number>();
    const next = (key: string) => {
      const n = (counter.get(key) ?? 0) + 1;
      counter.set(key, n);
      return n;
    };

    let locked = 0;
    for (const t of taskRows) {
      if (t.refLocked && t.ref) continue; // already done
      let prefix: string;
      let key: string;
      let projectId = t.projectId;
      if (t.boardId && boardCode.has(t.boardId)) {
        prefix = boardCode.get(t.boardId)!;
        key = `board:${t.boardId}`;
        projectId = boardProject.get(t.boardId) ?? projectId;
      } else if (projectId && projectCode.has(projectId)) {
        prefix = projectCode.get(projectId)!;
        key = `project:${projectId}`;
      } else {
        prefix = userCode!;
        key = "user";
      }
      const seq = t.seq ?? next(key);
      // Track the max so we advance the owner's counter below even if seq was
      // pre-assigned by createTask.
      counter.set(key, Math.max(counter.get(key) ?? 0, seq));
      await db
        .update(tasks)
        .set({
          seq,
          projectId,
          ref: `${prefix}-${seq}`,
          refLocked: true,
          lockedAt: new Date(),
        })
        .where(eq(tasks.id, t.id));
      locked++;
    }

    // 5. Advance each owner's nextSeq past the max seq it handed out.
    for (const [key, max] of counter) {
      const nextSeq = max + 1;
      if (key.startsWith("board:")) {
        await db.update(boards).set({ nextSeq }).where(eq(boards.id, key.slice(6)));
      } else if (key.startsWith("project:")) {
        await db.update(projects).set({ nextSeq }).where(eq(projects.id, key.slice(8)));
      } else {
        await db.update(users).set({ nextSeq }).where(eq(users.id, u.id));
      }
    }

    console.log(`  ${u.email}: code ${userCode}, ${locked} task(s) locked`);
  }

  // Sanity: warn about any board-less/project-less orphans (shouldn't happen).
  const orphans = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(isNull(tasks.boardId), isNull(tasks.projectId)));
  if (orphans.length)
    console.log(`  note: ${orphans.length} board-less task(s) used the user prefix`);

  console.log("Done ✅");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
