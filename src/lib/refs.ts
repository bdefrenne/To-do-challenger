/*
  ====================================================================
  TASK REFS / CODES — the human-friendly `GH-20` ids.

  A task's code is `<prefix>-<seq>`. The prefix resolves board → project →
  user (each carries an editable ≤4-char `code`); the number is drawn from
  that owner's counter. While a task is UNLOCKED the code is "soft" — it
  follows the task if it changes board, and renders with a trailing `*`
  (`GH-20*`). Locking freezes the exact string forever (see mintRef in
  db/service.ts). Gaps (from deletes / board moves of unlocked tasks) are
  expected and harmless, Jira-style.
  ====================================================================
*/

/** Strip a name down to a ≤4-char uppercase code candidate.
 *  "Guitar Hero" → "GH", "Tower Defense" → "TD", "Backend" → "BACK". */
export function deriveCode(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return "TASK";
  const words = cleaned.split(/[\s\-_/]+/).filter(Boolean);
  let candidate: string;
  if (words.length >= 2) {
    // Initials of the first up-to-4 words ("Guitar Hero" → "GH").
    candidate = words
      .slice(0, 4)
      .map((w) => w[0])
      .join("");
  } else {
    // Single word: first 4 letters ("Backend" → "BACK").
    candidate = words[0].slice(0, 4);
  }
  candidate = candidate.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return candidate.slice(0, 4) || "TASK";
}

/** Normalize an explicitly-typed code: uppercase, alnum only, ≤4 chars. */
export function sanitizeCode(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4);
  return cleaned || "TASK";
}

/** The locked form of a displayed code: drop the soft `*` marker. Locking never
 *  renumbers a task (the seq is already allocated at creation), so the client
 *  can cite the code a pending lock is about to freeze. */
export function lockedCode(code: string): string {
  return code.replace(/\*$/, "");
}

/** Format a displayed code from its parts. `locked` drops the soft `*` marker. */
export function formatCode(prefix: string, seq: number, locked: boolean): string {
  const base = `${prefix}-${seq}`;
  return locked ? base : `${base}*`;
}
