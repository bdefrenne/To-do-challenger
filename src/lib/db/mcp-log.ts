/*
  MCP CALL RECORDER (TD2-211)

  One function, called from one place: `instrument()` in the MCP route wraps
  `server.tool` so every tool — including one added next month by someone who
  never reads this file — records that it ran, for whom, with what, and how it
  went.

  Two rules this module exists to enforce:

  1. **Logging must never break a call.** Every write is fire-and-forget and
     swallows its own errors. A failed insert costs an audit row; a thrown
     insert would cost the user their tool call, which is a far worse trade.
  2. **Arguments are truncated before they reach Postgres.** `bulk_apply` can
     carry fifty operations and `update_task` a 20k-char plan; storing those in
     full would make the call log larger than the data it describes. We keep
     enough to recognise the call, not enough to replay it — that's what the
     task itself is for.
*/

import { db } from "./client";
import { mcpCalls } from "./schema";
import type { LogSource } from "./log-context";

/** Ceiling on the serialized `args` blob. Past this the value is replaced by a
 *  marker rather than silently cut mid-structure, so a reader is never fooled
 *  into thinking they're looking at the whole argument. */
const MAX_ARGS_CHARS = 4000;
/** Per-string ceiling inside `args` — the common case is one giant field
 *  (a plan, a description) in an otherwise small object, and clipping just that
 *  field keeps the rest of the call readable. */
const MAX_STRING_CHARS = 400;
const MAX_ERROR_CHARS = 1000;

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}… (${s.length} chars)`;

/** Shrink a tool's arguments to something worth storing: long strings clipped,
 *  long arrays summarized, and the whole thing dropped if it's still too big. */
function summarizeArgs(args: unknown): unknown {
  const shrink = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return clip(v, MAX_STRING_CHARS);
    if (Array.isArray(v)) {
      if (depth > 3) return `[${v.length} items]`;
      const head = v.slice(0, 20).map((x) => shrink(x, depth + 1));
      return v.length > 20 ? [...head, `… ${v.length - 20} more`] : head;
    }
    if (v && typeof v === "object") {
      if (depth > 3) return "{…}";
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          shrink(x, depth + 1),
        ]),
      );
    }
    return v;
  };
  if (args === undefined || args === null) return null;
  const small = shrink(args, 0);
  try {
    const s = JSON.stringify(small);
    if (s === undefined) return null;
    if (s.length > MAX_ARGS_CHARS) return { truncated: `${s.length} chars` };
    return small;
  } catch {
    return { unserializable: true };
  }
}

export interface McpCallRecord {
  userId: string | null;
  /** 'tool' | 'prompt' | 'resource' — which MCP entry point ran. */
  kind: string;
  name: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  resultBytes?: number;
  surface?: LogSource;
}

/**
 * Record one MCP invocation. Fire-and-forget by design — callers must NOT
 * await it, and it never rejects.
 */
export function recordMcpCall(rec: McpCallRecord): void {
  void db
    .insert(mcpCalls)
    .values({
      userId: rec.userId,
      surface: rec.surface ?? "mcp",
      kind: rec.kind,
      name: rec.name,
      args: summarizeArgs(rec.args),
      ok: rec.ok,
      error: rec.error ? clip(rec.error, MAX_ERROR_CHARS) : null,
      durationMs: Math.round(rec.durationMs),
      resultBytes: rec.resultBytes ?? null,
    })
    .catch((e) => {
      // Deliberately swallowed — see rule 1 in this file's header.
      console.error("[mcp-log] failed to record call", rec.name, e);
    });
}
