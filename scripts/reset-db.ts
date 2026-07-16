/*
  Drop every app object so the schema can be (re)created from scratch.
  Destructive by design — this is the "wipe everything" half of the
  multi-user reset. Run:  npm run db:reset  (then db:push + db:seed).
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const sql = neon(url);

  console.log("Dropping tables + types…");
  // CASCADE handles FKs and dependent objects; order-independent.
  await sql`DROP TABLE IF EXISTS task_logs CASCADE`;
  await sql`DROP TABLE IF EXISTS tasks CASCADE`;
  await sql`DROP TABLE IF EXISTS boards CASCADE`;
  await sql`DROP TABLE IF EXISTS projects CASCADE`;
  await sql`DROP TABLE IF EXISTS api_tokens CASCADE`;
  await sql`DROP TABLE IF EXISTS users CASCADE`;
  await sql`DROP TYPE IF EXISTS task_status CASCADE`;
  await sql`DROP TYPE IF EXISTS priority CASCADE`;
  await sql`DROP TYPE IF EXISTS recurrence CASCADE`;
  await sql`DROP TYPE IF EXISTS log_kind CASCADE`;
  // Clear drizzle's push/migrate bookkeeping too.
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

  console.log("Done ✅  Now run: npm run db:push && npm run db:seed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
