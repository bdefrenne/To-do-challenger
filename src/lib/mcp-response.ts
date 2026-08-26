/*
  ====================================================================
  MCP RESPONSE BUDGET — the one ceiling on how much a read sends back.

  An MCP client caps how much a single tool result may inject into the
  model's context (~25k tokens). Over that, the client spills the payload
  to a file and the model has to go fishing for it — the read "succeeded"
  while costing more than the question was worth.

  So no read is allowed to be unbounded. `capped()` measures the payload
  and, when it doesn't fit, REDUCES it and says exactly what it lost.
  Never a silent dump (the caller can't tell it's partial) and never a
  bare refusal (the caller learns nothing and pays for a round-trip).

  ---------------------------------------------------------------- TD2-210

  Two things here are load-bearing and easy to "simplify" back into bugs.

  1. THE BUDGET IS IN TOKENS, NOT CHARACTERS. A character budget cannot
     be made safe. Measured over every real payload this app has produced,
     chars-per-token spans 1.65 (a canvas: ids, numbers, timestamps) to
     3.74 (a bulk update: prose) — a 2.3x spread. The old `chars / 4`
     under-estimated by up to 45%, always in the unsafe direction, which
     is how an over-budget standup got returned by a guard that believed
     it had succeeded. `estimateTokens` splits letters from everything
     else, which tracks the real tokenizer closely enough to be safe.

  2. `serialize` IS ALWAYS COMPACT. Indentation is precisely what the
     estimator cannot model: runs of whitespace collapse into very few
     tokens, so a pretty-printed payload swings the estimate to -21% (too
     small — unsafe) or +90% (too big — throws away half the budget).
     Compacting removes that variable. It is not an optimisation; it is
     what makes the estimate trustworthy. Measured on compact payloads
     the estimator's worst case is -3%, which the safety fraction covers.

  The ladder below is TOTAL: every stage returns a candidate payload and
  only `emit` serialises and measures, with `MINIMAL` — a module constant
  asserted smaller than the smallest permitted budget — as the last rung.
  That is what makes the ceiling provable rather than merely measured.
  ====================================================================
*/

/* One definition of "don't end mid-word", shared with the UI's teasers. */
import { cutOnBoundary } from "@/lib/format";

/** What the MCP client will accept in one tool result. */
export const CLIENT_TOKEN_CAP = 25_000;

/** Headroom for the JSON-RPC framing around the result and for variance in
 *  the estimate. The estimator's worst observed under-count is 3%. */
export const SAFETY_FRACTION = 0.85;

/** The ceiling every read is held to. Derived, so the arithmetic is in the
 *  code rather than in a comment that has already drifted once. */
export const BUDGET_TOKENS = Math.floor(CLIENT_TOKEN_CAP * SAFETY_FRACTION);

/** Floor for a caller-supplied `budget`. Guards the `MINIMAL` invariant. */
export const MIN_BUDGET_TOKENS = 400;

/** Envelope key. Underscored because it is transport metadata, and because
 *  the plain name collided with `bulk_apply`'s own `truncated: boolean`. */
export const TRUNCATION_KEY = "_truncation";


/** Ladder of per-string caps tried before any row is dropped. */
const TEXT_LADDER = [4_000, 2_000, 1_000, 400, 200] as const;

/** Appended to a string this module shortened. */
const TRIM_MARK = " …[truncated]";
const PREVIEW_MARK = " …[trimmed]";

/** Arrays holding less than this share of the payload aren't worth cutting;
 *  relative rather than absolute so it degrades gracefully on odd shapes. */
const AXIS_MIN_SHARE = 0.02;

/** One level of descent past the top covers every shape we return today
 *  (`drift.plannedNotDone` is the only nested axis). Named so a future
 *  payload with deeper arrays fails diagnosably rather than mysteriously. */
const MAX_AXIS_DEPTH = 2;

/** Resolution of the keep-fraction search. */
const K_GRID = 1024;

/** Rough chars-per-token for the mixed JSON we actually emit — used only to
 *  size `preview` teasers, never to enforce the ceiling. */
const MIXED_CHARS_PER_TOKEN = 2.5;

/** Share of the budget a digest may spend on teaser text. */
const PREVIEW_SHARE = 0.35;
const PREVIEW_FLOOR = 120;
const PREVIEW_CEIL = 600;

/** The last rung. A module constant so the ceiling is structural: nothing
 *  below can be bigger, and the assertion below proves it fits any budget
 *  we permit. Never slice a JSON string to fit — that turns a size failure
 *  into an unparseable-response failure. */
const MINIMAL =
  '{"error":"response_too_large","hint":"This tool result exceeded the response budget and could not be reduced. Narrow the query (filters, date window, limit) and call again."}';

/* ------------------------------ estimation ------------------------------ */

/**
 * Estimated tokens for `s`.
 *
 * Letters run about 4 chars per token; digits, punctuation, ids and
 * timestamps run closer to 1.6, which is why an all-UUID payload tokenises
 * more than twice as densely as prose. Splitting on that one axis is enough
 * to stay on the safe side of the real tokenizer for compact JSON.
 */
export function estimateTokens(s: string): number {
  let letters = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
  }
  return Math.ceil(letters / 4 + (s.length - letters) / 1.6);
}

/** The JSON we actually emit — compact, for the reason in the header. */
export const serialize = (data: unknown): string =>
  typeof data === "string" ? data : JSON.stringify(data) ?? "null";

/* -------------------------------- types --------------------------------- */

export interface CapOpts {
  /**
   * Field(s) to cut FIRST, e.g. "tasks". A HINT ONLY — the guard holds
   * without it, which matters because most call sites pass nothing and the
   * two that named a field both named the wrong one.
   */
  items?: string | readonly string[];
  /** Honest match count for the query, so the envelope can say "42 of 98".
   *  Omitted rather than faked when the caller doesn't know it. */
  total?: number;
  /** Filter names that would narrow this read. */
  narrow?: readonly string[];
  /** Budget in TOKENS. Test/check-script override; clamped upward. */
  budget?: number;
}

export interface CutRecord {
  field: string;
  returned: number;
  of: number;
}

export interface Truncation {
  reason: "response_budget";
  budgetTokens: number;
  /** Every axis that lost rows, named. */
  cut?: CutRecord[];
  /** Long strings were shortened to this many chars. */
  textTrimmedTo?: number;
  /** Which fields those were, so a per-record re-read is targeted. */
  truncatedFields?: string[];
  total?: number;
  narrow: readonly string[];
  hint: string;
}

export interface CapResult {
  text: string;
  truncation?: Truncation;
}

/* ------------------------------- helpers -------------------------------- */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Shorten every string in `data` to `max` chars, reporting which fields were
 * actually cut. Row COUNT is preserved — an agent still sees every id and can
 * re-read the records it needs, which is strictly better than fewer whole rows.
 */
export function trimText(
  data: unknown,
  max: number,
): { data: unknown; fields: string[] } {
  const fields = new Set<string>();
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") {
      if (v.length <= max) return v;
      fields.add(path || "(root)");
      return cutOnBoundary(v, max) + TRIM_MARK;
    }
    // Array elements share their parent's path: "shipped[].summary", once.
    if (Array.isArray(v)) return v.map((x) => walk(x, path));
    if (isPlainObject(v))
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          walk(x, path ? `${path}.${k}` : k),
        ]),
      );
    return v;
  };
  return { data: walk(data, ""), fields: [...fields].slice(0, 20) };
}

interface Axis {
  path: string;
  rows: unknown[];
  weight: number;
}

/**
 * Find every array worth cutting. Auto-discovery rather than a caller-supplied
 * field name, because the callers that named one both named the wrong one and
 * most name none at all — a guard nobody can misconfigure is the whole point.
 */
function discoverAxes(data: unknown): Axis[] {
  if (!isPlainObject(data)) return [];
  const found: Axis[] = [];
  const consider = (path: string, v: unknown) => {
    if (Array.isArray(v) && v.length)
      found.push({ path, rows: v, weight: serialize(v).length });
  };
  for (const [k, v] of Object.entries(data)) {
    consider(k, v);
    if (MAX_AXIS_DEPTH > 1 && isPlainObject(v))
      for (const [k2, v2] of Object.entries(v)) consider(`${k}.${k2}`, v2);
  }
  const total = found.reduce((n, a) => n + a.weight, 0) || 1;
  return found
    .filter((a) => a.weight / total >= AXIS_MIN_SHARE)
    .sort((a, b) => b.weight - a.weight);
}

/** Keep `floor(len * k)` rows of every axis. Monotone in `k`, which is what
 *  makes the binary search below correct. */
function applyK(
  data: Record<string, unknown>,
  axes: Axis[],
  k: number,
): { payload: Record<string, unknown>; cuts: CutRecord[] } {
  const out: Record<string, unknown> = { ...data };
  const nested = new Map<string, Record<string, unknown>>();
  const cuts: CutRecord[] = [];
  for (const a of axes) {
    const n = Math.min(a.rows.length, Math.floor(a.rows.length * k));
    if (n < a.rows.length)
      cuts.push({ field: a.path, returned: n, of: a.rows.length });
    const kept = a.rows.slice(0, n);
    const dot = a.path.indexOf(".");
    if (dot === -1) {
      out[a.path] = kept;
    } else {
      const parent = a.path.slice(0, dot);
      const child = a.path.slice(dot + 1);
      let obj = nested.get(parent);
      if (!obj) {
        obj = { ...(out[parent] as Record<string, unknown>) };
        nested.set(parent, obj);
        out[parent] = obj;
      }
      obj[child] = kept;
    }
  }
  return { payload: out, cuts };
}

/* --------------------------------- core --------------------------------- */

/**
 * Serialize `data` within the response budget.
 *
 * The ladder, in order — text before rows, deliberately:
 *   0. a bare string      → cut on a boundary, inline marker
 *   1. it fits            → byte-identical, no envelope
 *   2. trim long strings  → every row survives, its text teased
 *   3. cut rows           → one keep-fraction across ALL arrays at once
 *   4. last resort        → drop the payload, say what shape it was
 *   5. MINIMAL            → the constant that cannot not fit
 */
export function cappedDetailed(data: unknown, opts: CapOpts = {}): CapResult {
  const budget = Math.max(opts.budget ?? BUDGET_TOKENS, MIN_BUDGET_TOKENS);
  const fits = (s: string) => estimateTokens(s) <= budget;
  const narrow = opts.narrow ?? [];
  const base = (extra: Partial<Truncation>): Truncation => ({
    reason: "response_budget",
    budgetTokens: budget,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    narrow,
    hint: narrow.length
      ? "Narrow with the filters above and call again — don't page blindly."
      : "Narrow the query and call again — don't page blindly.",
    ...extra,
  });

  /* 0. A bare string (a markdown board view). Never spread it into an
        object — that was producing {"0":"c","1":"h",…}, one key per
        character: a corrupt response, not a truncated one. */
  if (typeof data === "string") {
    if (fits(data)) return { text: data };
    const mark = (kept: number) =>
      `\n\n…[truncated: ${kept.toLocaleString()} of ${data.length.toLocaleString()} chars.` +
      (narrow.length ? ` Narrow with: ${narrow.join(", ")}.` : "") +
      ` Read individual records for the rest.]`;
    // Shrink until the marked text fits; the marker itself is tiny and bounded.
    let hi = data.length;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(cutOnBoundary(data, mid) + mark(mid))) lo = mid;
      else hi = mid - 1;
    }
    const kept = cutOnBoundary(data, lo);
    const text = kept + mark(kept.length);
    return {
      text: fits(text) ? text : MINIMAL,
      truncation: base({ textTrimmedTo: lo }),
    };
  }

  /* 1. Fits as-is. */
  const body = serialize(data);
  if (fits(body)) return { text: body };

  const emit = (payload: unknown, t: Truncation): string =>
    serialize(
      isPlainObject(payload)
        ? { ...payload, [TRUNCATION_KEY]: t }
        : { value: payload, [TRUNCATION_KEY]: t },
    );

  /* 2. Trim long strings. Preserves row count. */
  let reduced: unknown = data;
  let trimmedTo: number | undefined;
  let trimmedFields: string[] = [];
  for (const max of TEXT_LADDER) {
    const { data: out, fields } = trimText(data, max);
    if (!fields.length) continue; // nothing that long — next rung is no better
    reduced = out;
    trimmedTo = max;
    trimmedFields = fields;
    const t = base({ textTrimmedTo: max, truncatedFields: fields });
    const text = emit(out, t);
    if (fits(text)) return { text, truncation: t };
  }

  /* 3. Cut rows, on the most-trimmed payload we produced above. One global
        keep-fraction across every axis — never per-axis, which is how a small
        named field used to be driven to zero while a large sibling survived
        whole and the response still went out over budget. */
  if (isPlainObject(reduced)) {
    const textPart = trimmedTo
      ? { textTrimmedTo: trimmedTo, truncatedFields: trimmedFields }
      : {};
    const named =
      opts.items === undefined
        ? []
        : Array.isArray(opts.items)
          ? opts.items
          : [opts.items as string];
    const all = discoverAxes(reduced);
    // Honour the caller's hint first, then widen to every axis if that
    // wasn't enough. The hint can help; it can no longer hurt.
    const attempts = named.length
      ? [all.filter((a) => named.includes(a.path)), all]
      : [all];

    for (const axes of attempts) {
      if (!axes.length) continue;
      let lo = 0;
      let hi = K_GRID;
      const tryK = (g: number) => applyK(reduced as Record<string, unknown>, axes, g / K_GRID);
      const fitsAt = (g: number) => {
        const { payload, cuts } = tryK(g);
        return fits(emit(payload, base({ ...textPart, cut: cuts })));
      };
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsAt(mid)) lo = mid;
        else hi = mid - 1;
      }
      const { payload, cuts } = tryK(lo);
      const t = base({ ...textPart, cut: cuts });
      const text = emit(payload, t);
      if (fits(text)) return { text, truncation: t };
    }
  }

  /* 4. Nothing fit. Say so honestly, and describe the shape so the caller can
        narrow on something real. This is an error, NOT a `truncated` envelope
        claiming success — the old code's worst habit. */
  const census = isPlainObject(reduced)
    ? Object.entries(reduced)
        .map(([field, v]) =>
          Array.isArray(v)
            ? { field, kind: "array" as const, count: v.length }
            : typeof v === "string"
              ? { field, kind: "text" as const, chars: v.length }
              : { field, kind: typeof v },
        )
        .slice(0, 20)
    : undefined;
  for (const shape of [census, undefined]) {
    const text = serialize({
      error: "response_too_large",
      budgetTokens: budget,
      estimatedTokens: estimateTokens(body),
      ...(shape ? { shape } : {}),
      narrow,
      hint: "Nothing fit. Narrow with the filters above, or read one record at a time.",
    });
    if (fits(text)) return { text, truncation: base({}) };
  }

  /* 5. The rung that cannot fail. */
  return { text: MINIMAL, truncation: base({}) };
}

/** The form every call site uses. See `cappedDetailed` for the ladder. */
export function capped(data: unknown, opts: CapOpts = {}): string {
  return cappedDetailed(data, opts).text;
}

/* ------------------------------- previews ------------------------------- */

/**
 * A teaser for a long free-text field.
 *
 * Strips leading markdown headings first: summaries here routinely open with
 * `## What shipped`, and spending a teaser's budget on a header that says
 * nothing is how a preview ends up useless. Then collapses whitespace and cuts
 * on a word boundary. Structure-preserving enough to stay honest, unlike the
 * UI's `previewOf`, which flattens to a single ` · ` line.
 */
export function preview(
  text: string | null | undefined,
  max: number,
): string | null {
  if (!text?.trim()) return text ?? null;
  let s = text.trim();
  for (;;) {
    const m = /^\s*#{1,6}[^\n]*(\n+|$)/.exec(s);
    if (!m || !m[0].trim()) break;
    s = s.slice(m[0].length);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : cutOnBoundary(s, max) + PREVIEW_MARK;
}

/**
 * How many chars of teaser each row may have, given how many rows there are.
 *
 * A fixed constant is wrong in both directions: too stingy on an eight-task
 * day, too greedy on a quarter-wide window. Spending the budget you actually
 * have turns a wide read from "truncated" into "complete but teased", which is
 * the outcome the ceiling alone can't reach. Still only a heuristic — the
 * ladder above remains the guarantee.
 */
export function previewBudget(
  rows: number,
  opts: {
    budget?: number;
    share?: number;
    floor?: number;
    ceil?: number;
  } = {},
): number {
  const budget = Math.max(opts.budget ?? BUDGET_TOKENS, MIN_BUDGET_TOKENS);
  const chars = budget * MIXED_CHARS_PER_TOKEN * (opts.share ?? PREVIEW_SHARE);
  const per = Math.floor(chars / Math.max(rows, 1));
  return Math.max(
    opts.floor ?? PREVIEW_FLOOR,
    Math.min(opts.ceil ?? PREVIEW_CEIL, per),
  );
}

/* The ceiling is only provable if the last rung fits the smallest budget we
   permit. Checked at module load so it can never quietly stop being true. */
if (estimateTokens(MINIMAL) > MIN_BUDGET_TOKENS)
  throw new Error("mcp-response: MINIMAL exceeds MIN_BUDGET_TOKENS");
