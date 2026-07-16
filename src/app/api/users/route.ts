/*
  GET /api/users — the roster of accounts (everyone who can be assigned).

  Used by the web UI to resolve assignee display-names to a picture + color
  and to populate the assignee picker. Scoped only by "must be signed in";
  the fields returned are already the public view (no password hash).
*/

import { route, json } from "@/lib/api";
import { listUsers } from "@/lib/db/users";

export const GET = route(async () => json({ users: await listUsers() }));
