/*
  Neon serverless DB client. Uses the HTTP driver so it works cleanly
  inside Vercel serverless functions (no long-lived connections).

  Lazily initialized: we don't touch DATABASE_URL until the first query,
  so `next build` (and importing route modules) never fails just because
  the env isn't present at build time.
*/

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;

function init(): DB {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Create a Neon Postgres DB (Vercel → Storage) " +
        "and run `vercel env pull .env.local`, or set it in .env.local.",
    );
  }
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

/** Drizzle client — initialized on first use. */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    _db ??= init();
    // @ts-expect-error — forward property access to the real client
    return _db[prop];
  },
});

export { schema };
