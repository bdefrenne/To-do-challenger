/*
  REQUEST LOG-CONTEXT — carries WHO is acting and from WHICH surface for the
  duration of a request, so the activity-log writer (`log()` in service.ts) can
  stamp every new task_logs row with `actorId` + `source` without threading two
  extra params through ~15 service mutators.

  Set once at each auth boundary:
    • REST/UI  — `route()` in src/lib/api.ts     (session → "ui", token → "api")
    • MCP      — `authed()` in src/app/api/mcp/route.ts  ("mcp")
    • Telegram — `executeDestructive()` in src/lib/telegram/executor.ts

  `source` is also the POLICY input for work-entry assignment: entering a work
  status from an agent surface records the actor as an assignee, from the web UI
  it doesn't (see ASSIGNING_SOURCES in service.ts). Same reasoning as above —
  it's a per-request fact every mutator needs, so it rides the context rather
  than a boolean at every call site.

  Mirrors the AsyncLocalStorage pattern the MCP route already uses for userId.
*/

import { AsyncLocalStorage } from "node:async_hooks";

export type LogSource = "ui" | "api" | "mcp" | "telegram";

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
