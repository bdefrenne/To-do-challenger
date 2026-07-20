/*
  Seed the database from the original mock data so the app has content
  on first run. Idempotent: clears the tables, then re-inserts.

  Run:  npm run db:seed   (needs DATABASE_URL in .env.local / env)
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { db } from "../src/lib/db/client";
import {
  tasks,
  taskLogs,
  users,
  apiTokens,
  projects,
  boards,
} from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/session";
import { TASKS } from "../src/lib/mock-data";
import { STATUS_LABEL } from "../src/lib/statuses";
import type { Task } from "../src/lib/types";

const FALLBACK = "2026-07-10T10:00:00+02:00";

/* The owner account the seeded tasks are assigned to. Override via env. */
const OWNER_EMAIL = process.env.SEED_EMAIL ?? "ben@decarbony.com";
const OWNER_NAME = process.env.SEED_NAME ?? "Ben";
const OWNER_PASSWORD = process.env.SEED_PASSWORD ?? "changeme-123";

async function insertTask(
  t: Task,
  userId: string,
  boardId: string | null,
  parentId: string | null,
  position: number,
) {
  const statusSince = t.updatedAt ?? FALLBACK;
  await db.insert(tasks).values({
    id: t.id,
    userId,
    boardId,
    title: t.title,
    status: t.status,
    assigneeIds: t.assigneeIds ?? [],
    startDate: t.startDate,
    dueDate: t.dueDate,
    recurrence: t.recurrence,
    dependsOn: t.dependsOn ?? [],
    customFields: t.customFields ?? {},
    value: t.value,
    difficulty: t.difficulty,
    description: t.description,
    parentId,
    position,
    statusSince: new Date(statusSince),
    completedAt: t.status === "done" ? new Date(statusSince) : null,
    createdAt: new Date(new Date(statusSince).getTime() - 2 * 86_400_000),
    updatedAt: new Date(statusSince),
  });

  // A minimal, honest activity trail.
  const created = new Date(new Date(statusSince).getTime() - 2 * 86_400_000);
  await db.insert(taskLogs).values({
    taskId: t.id,
    at: created,
    kind: "created",
    message: "Task created",
    author: t.assigneeIds?.[0] ?? "You",
  });
  if (t.status !== "backlog") {
    await db.insert(taskLogs).values({
      taskId: t.id,
      at: new Date(statusSince),
      kind: t.status === "done" ? "done" : t.status === "building" ? "started" : "moved",
      message:
        t.status === "done"
          ? "Completed"
          : t.status === "building"
            ? "Started"
            : `Moved to ${STATUS_LABEL[t.status]}`,
      author: t.assigneeIds?.[0] ?? "You",
    });
  }
  // Seed a couple of comments so commentCount is honest.
  for (let i = 0; i < (t.commentCount ?? 0); i++) {
    await db.insert(taskLogs).values({
      taskId: t.id,
      at: new Date(statusSince),
      kind: "comment",
      message: `Sample comment ${i + 1}`,
      author: "You",
    });
  }
}

async function main() {
  console.log("Clearing existing data…");
  await db.delete(taskLogs);
  await db.delete(tasks);
  await db.delete(boards);
  await db.delete(projects);
  await db.delete(apiTokens);
  await db.delete(users);

  console.log(`Creating owner account (${OWNER_EMAIL})…`);
  const [owner] = await db
    .insert(users)
    .values({
      email: OWNER_EMAIL.toLowerCase(),
      name: OWNER_NAME,
      passwordHash: hashPassword(OWNER_PASSWORD),
    })
    .returning();

  console.log("Creating default Personal → Inbox board…");
  const [project] = await db
    .insert(projects)
    .values({ userId: owner.id, name: "Personal", position: 1 })
    .returning();
  const [inbox] = await db
    .insert(boards)
    .values({ userId: owner.id, projectId: project.id, name: "Inbox", position: 1 })
    .returning();

  console.log(`Seeding ${TASKS.length} top-level tasks for ${owner.email}…`);
  let topPos = 1;
  for (const t of TASKS) {
    await insertTask(t, owner.id, inbox.id, null, topPos++);
    let subPos = 1;
    for (const s of t.subtasks ?? [])
      await insertTask(s, owner.id, inbox.id, t.id, subPos++);
  }

  console.log("Done ✅");
  console.log(`\n  Sign in:  ${OWNER_EMAIL}`);
  console.log(`  Password: ${OWNER_PASSWORD}`);
  if (!process.env.SEED_PASSWORD) {
    console.log("  (default password — set SEED_PASSWORD to choose your own)");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
