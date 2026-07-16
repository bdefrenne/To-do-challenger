/*
  Backfill projects/boards for existing data. Idempotent and per-user:
  for every user, ensure a "Personal" project with an "Inbox" board exists,
  then assign any board-less tasks to that Inbox.

  Safe to run repeatedly. Run after `npm run db:push`:
    npm run db:backfill
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { users, projects, boards, tasks } from "../src/lib/db/schema";

const PROJECT_NAME = "Personal";
const BOARD_NAME = "Inbox";

async function ensureInbox(userId: string): Promise<string> {
  // Project
  let project = (
    await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.name, PROJECT_NAME)))
      .limit(1)
  )[0];
  if (!project) {
    [project] = await db
      .insert(projects)
      .values({ userId, name: PROJECT_NAME, position: 1 })
      .returning();
  }

  // Board
  let board = (
    await db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.userId, userId),
          eq(boards.projectId, project.id),
          eq(boards.name, BOARD_NAME),
        ),
      )
      .limit(1)
  )[0];
  if (!board) {
    [board] = await db
      .insert(boards)
      .values({ userId, projectId: project.id, name: BOARD_NAME, position: 1 })
      .returning();
  }
  return board.id;
}

async function main() {
  const allUsers = await db.select().from(users);
  console.log(`Backfilling boards for ${allUsers.length} user(s)…`);

  for (const u of allUsers) {
    const inboxId = await ensureInbox(u.id);
    const updated = await db
      .update(tasks)
      .set({ boardId: inboxId })
      .where(and(eq(tasks.userId, u.id), isNull(tasks.boardId)))
      .returning({ id: tasks.id });
    console.log(
      `  ${u.email}: Personal → Inbox ready, ${updated.length} task(s) assigned`,
    );
  }

  console.log("Done ✅");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
