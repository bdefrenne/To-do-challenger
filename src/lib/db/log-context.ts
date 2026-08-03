/*
  REQUEST LOG-CONTEXT — carries WHO is acting and from WHICH surface for the
  duration of a request, so the activity-log writer (`log()` in service.ts) can
  stamp every new task_logs row with `actorId` + `source` without threading two
  extra params through ~15 service mutators.

  Set once at each auth boundary:
    • REST/UI  — `route()` in src/lib/api.ts     (session → "ui", token → "api")
    • MCP      — `authed()` in src/app/api/mcp/route.ts  ("mcp")

  Mirrors the AsyncLocalStorage pattern the MCP route already uses for userId.
*/

import { AsyncLocalStorage } from "node:async_hooks";

export type LogSource = "ui" | "api" | "mcp";

export interface LogContext {
  /** The real acting user's account id. */
  actorId: string;
  /** Which surface produced the request. */
  source: LogSource;
}

const store = new AsyncLocalStorage<LogContext>();

/** Run `fn` with the given actor/source stamped onto any activity logged inside. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The active request's actor/source, or undefined outside a request. */
export function currentLogContext(): LogContext | undefined {
  return store.getStore();
}
