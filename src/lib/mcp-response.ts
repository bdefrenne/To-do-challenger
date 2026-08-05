/*
  ====================================================================
  MCP RESPONSE BUDGET — the one ceiling on how much a read sends back.

  An MCP client caps how much a single tool result may inject into the
  model's context (~25k tokens by default). Over that, the client spills
  the payload to a file and the model has to go fishing for it — the
  read "succeeded" while costing more than the question was worth.

  So no read is allowed to be unbounded. `capped()` measures the payload
  and, when it doesn't fit, TRUNCATES it and says so, naming the filters
  that would narrow the next call. Never a silent dump (the caller can't
  tell it's partial) and never a bare refusal (the caller learns nothing
  and pays for a second round-trip).

  Every MCP tool returns through `text()` in the route, which is this.
  ====================================================================
*/

/** ~22.5k tokens at 4 chars/token, leaving headroom under a 25k cap. */
export const BUDGET_CHARS = 90_000;

/** Room for the `truncated` envelope we append after cutting rows. */
const ENVELOPE_HEADROOM = 500;

/** The pretty-printed JSON we actually emit — so length checks measure the
 *  real payload, not a compact approximation of it. */
export const serialize = (data: unknown): string =>
  typeof data === "string" ? data : JSON.stringify(data, null, 2);

/** Cut the long strings in a too-big single object (a task whose plan runs to
 *  20k chars) instead of dropping the whole thing. Marks every cut. */
export function trimLongStrings(data: unknown, max: number): unknown {
  if (typeof data === "string")
    return data.length > max ? data.slice(0, max) + " …[truncated]" : data;
  if (Array.isArray(data)) return data.map((v) => trimLongStrings(v, max));
  if (data && typeof data === "object")
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, trimLongStrings(v, max)]),
    );
  return data;
}

export interface CapOpts {
  /** Field holding the payload's rows, e.g. "tasks" — what gets cut first. */
  items?: string;
  /** Honest match count for the query, so the envelope can say "42 of 98". */
  total?: number;
  /** Filter names that would narrow this read. */
  narrow?: readonly string[];
  /** Override for tests. */
  budget?: number;
}

/**
 * Serialize `data` within the response budget.
 *
 * With `items`, rows are dropped from the tail until the payload fits — a
 * binary search, so one oversized row can't strand the whole read — and a
 * `truncated` envelope is attached. Without it (or for a non-array payload),
 * the longest strings are cut instead.
 */
export function capped(data: unknown, opts: CapOpts = {}): string {
  const budget = opts.budget ?? BUDGET_CHARS;
  const body = serialize(data);
  if (body.length <= budget) return body;

  const reason = `response budget (~${Math.round(budget / 4 / 1000)}k tokens)`;
  const key = opts.items;
  const rows =
    key && data && typeof data === "object"
      ? (data as Record<string, unknown>)[key]
      : undefined;

  if (Array.isArray(rows)) {
    const fits = (n: number) =>
      serialize({ ...(data as object), [key!]: rows.slice(0, n) }).length <=
      budget - ENVELOPE_HEADROOM;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    const kept = rows.slice(0, lo);
    return serialize({
      ...(data as object),
      [key!]: kept,
      truncated: {
        total: opts.total ?? rows.length,
        returned: kept.length,
        reason,
        narrow: opts.narrow ?? [],
        hint: "Narrow with the filters above and call again — don't page blindly.",
      },
    });
  }

  return serialize({
    ...(trimLongStrings(data, 4_000) as object),
    truncated: {
      reason,
      hint: "Long text fields were cut. Read the one record you need for the full text.",
    },
  });
}
