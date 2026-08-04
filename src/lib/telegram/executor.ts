/*
  ====================================================================
  DESTRUCTIVE EXECUTOR — runs a confirmed proposal AFTER the Confirm tap.

  The model never runs these (delete_task / bulk_update / bulk_apply are
  disabled on the connector). It proposes them via propose_destructive; we
  freeze the plan; and only here — post-tap — do we execute, straight
  through the service layer with the resolved userId (no self-HTTP) and
  validated with the same Zod schemas the REST/MCP paths use, since the
  model's arguments are untrusted input.
  ====================================================================*/

import { z } from "zod";
import { bulkUpdateSchema, bulkApplySchema } from "@/lib/api";
import { deleteTask, bulkUpdate, bulkApply } from "@/lib/db/service";
import { withLogContext } from "@/lib/db/log-context";
import type { PendingConfirm } from "@/lib/db/telegram";

const AI_AUTHOR = "Claude";
const deleteSchema = z.object({ id: z.string() });

/**
 * Execute a confirmed proposal. Returns a one-line result for the chat.
 *
 * Wrapped in the request log-context, like every other auth boundary: it stamps
 * the activity trail with who acted and from where (these rows were previously
 * unattributed — the model reaches the service layer directly here, not through
 * the MCP route's wrapper), and it's what tells the service layer this is an
 * agent surface, so entering a work status records the assignee.
 */
export async function executeDestructive(
  pending: PendingConfirm,
  userId: string,
): Promise<string> {
  return withLogContext({ actorId: userId, source: "telegram" }, async () => {
    const done: string[] = [];
    for (const call of pending.calls) {
      switch (call.tool) {
        case "delete_task": {
          const { id } = deleteSchema.parse(call.input);
          await deleteTask(id, userId);
          done.push("deleted 1 task");
          break;
        }
        case "bulk_update": {
          const { ids, patch } = bulkUpdateSchema.parse(call.input);
          const res = await bulkUpdate(userId, ids, patch, AI_AUTHOR);
          done.push(
            `updated ${res.updated} task${res.updated === 1 ? "" : "s"}` +
              // Ids that resolved to nothing are skipped, not updated — saying
              // otherwise tells the user a change landed when it didn't.
              (res.skipped.length ? `, ${res.skipped.length} not found` : ""),
          );
          break;
        }
        case "bulk_apply": {
          const { operations } = bulkApplySchema.parse(call.input);
          // `bulkApply` is best-effort: ops fail individually, and anything past
          // the per-batch cap is dropped. Report what actually happened rather
          // than echoing back how much was asked for.
          const res = await bulkApply(userId, operations, AI_AUTHOR);
          const failed = res.results.filter((r) => !r.ok).length;
          const applied = res.results.length - failed;
          done.push(
            `applied ${applied} change${applied === 1 ? "" : "s"}` +
              (failed ? `, ${failed} failed` : "") +
              (res.truncated
                ? `, ${operations.length - res.results.length} skipped (batch too large)`
                : ""),
          );
          break;
        }
      }
    }
    return done.length ? `✅ Done — ${done.join(", ")}.` : "Nothing to do.";
  });
}
