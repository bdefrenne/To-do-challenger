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
import type { PendingConfirm } from "@/lib/db/telegram";

const AI_AUTHOR = "Claude";
const deleteSchema = z.object({ id: z.string() });

/** Execute a confirmed proposal. Returns a one-line result for the chat. */
export async function executeDestructive(
  pending: PendingConfirm,
  userId: string,
): Promise<string> {
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
        done.push(`updated ${res.updated} task${res.updated === 1 ? "" : "s"}`);
        break;
      }
      case "bulk_apply": {
        const { operations } = bulkApplySchema.parse(call.input);
        await bulkApply(userId, operations, AI_AUTHOR);
        done.push(`applied ${operations.length} changes`);
        break;
      }
    }
  }
  return done.length ? `✅ Done — ${done.join(", ")}.` : "Nothing to do.";
}
