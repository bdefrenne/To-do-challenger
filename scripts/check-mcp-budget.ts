/*
  ====================================================================
  MCP RESPONSE BUDGET — the checks (TD2-210).

      npm run check:budget

  Pure functions only: no database, no MCP, no clock.

  `capped()` is the single guard keeping a tool result inside the MCP
  client's context cap. Before this suite it had no coverage at all, and
  it did not work: it returned payloads 3.4x over budget while attaching
  an envelope that claimed it had truncated them. Four separate defects,
  each of which shipped, each of which has a named case below.

  The one that matters most is the FUZZ check at the end. Everything else
  asserts a known case; the fuzz asserts the actual invariant — that no
  input of any shape, at any permitted budget, comes back over the
  ceiling. That is the property the whole file exists to provide, and it
  is the only one that catches the defect nobody thought of.
  ==================================================================== */

import {
  BUDGET_TOKENS,
  MIN_BUDGET_TOKENS,
  TRUNCATION_KEY,
  capped,
  cappedDetailed,
  estimateTokens,
  preview,
  previewBudget,
  serialize,
  trimText,
} from "@/lib/mcp-response";

/* ------------------------------- harness -------------------------------- */

let passed = 0;
const failures: string[] = [];
let section = "";

const group = (name: string) => {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};

const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures.push(
      `${section} → ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`,
    );
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
  }
};

/* ------------------------------- fixtures ------------------------------- */

const PROSE =
  "Shipped a solo race mode against computer-driven bots, reachable from the " +
  "circuit page. A bot is a real car on the game's own physics, fed the same " +
  "two inputs a human gives, so it drifts and bogs down for the same reasons. ";

const row = (i: number, chars = 3_000) => ({
  id: `2b5911c1-501e-468c-b18d-6b89a8bd4b${String(i).padStart(3, "0")}`,
  code: `TD2-${i}`,
  title: `Task number ${i}`,
  summary: PROSE.repeat(Math.ceil(chars / PROSE.length)).slice(0, chars),
});

const rows = (n: number, chars = 3_000) =>
  Array.from({ length: n }, (_, i) => row(i, chars));

/** The budget the guard must hold, in tokens, for a given output. */
const overBudget = (text: string, budget: number) =>
  estimateTokens(text) > budget;

/* ------------------------------ the checks ------------------------------ */

group("estimateTokens — the measurement the ceiling rests on");
{
  eq("empty string is zero", estimateTokens(""), 0);
  eq(
    "prose is cheaper per char than ids",
    estimateTokens("a".repeat(400)) < estimateTokens("-".repeat(400)),
    true,
  );
  // A UUID-dense payload is the case a chars/4 budget under-counted by ~45%.
  const uuids = serialize(rows(20, 0));
  eq(
    "an id-dense payload estimates denser than 3 chars/token",
    uuids.length / estimateTokens(uuids) < 3,
    true,
  );
  const prose = PROSE.repeat(50);
  // The real tokenizer puts prose near 4.0; we deliberately credit it less,
  // because under-crediting is the safe direction for a ceiling.
  eq(
    "prose estimates looser than ids, and conservatively",
    prose.length / estimateTokens(prose) > 2.9,
    true,
  );
}

group("serialize — compact, because the estimator can't model whitespace");
{
  eq("no indentation", serialize({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}');
  eq("a string passes through untouched", serialize("# hi\n\nthere"), "# hi\n\nthere");
  eq("undefined does not become the literal undefined", serialize(undefined), "null");
}

group("defect 1 — the unbounded fallback (no `items` passed)");
{
  // 23 of 28 call sites pass no `items`. This returned 305,268 chars against
  // a 90,000 budget, with an envelope claiming the text had been cut.
  const budget = 2_000;
  const out = capped({ things: rows(100) }, { budget });
  eq("fits the budget", overBudget(out, budget), false);
  eq("parses", typeof JSON.parse(out), "object");
  eq("says it was truncated", TRUNCATION_KEY in JSON.parse(out), true);
}

group("defect 2 — `items` naming the wrong field");
{
  // The live standup bug: `items:"shipped"` while `worked` held the bulk.
  // The old binary search drove `shipped` to zero and shipped it anyway.
  const budget = 2_000;
  const data = { shipped: rows(3), worked: rows(400) };
  const { text, truncation } = cappedDetailed(data, {
    items: "shipped",
    budget,
    narrow: ["from", "to", "credited"],
  });
  eq("fits the budget", overBudget(text, budget), false);
  eq(
    "the envelope names the sibling that actually got cut",
    (truncation?.cut ?? []).some((c) => c.field === "worked"),
    true,
  );
  eq("narrow filters are reported", truncation?.narrow, [
    "from",
    "to",
    "credited",
  ]);
}

group("defect 3 — a bare string must never be spread");
{
  // `format:"markdown"` returns a string. The old code spread it into an
  // object, producing {"0":"c","1":"h",…} — corrupt, not truncated.
  const budget = 1_000;
  const board = ("## Board\n\n- " + PROSE).repeat(400);
  const out = capped(board, { budget, narrow: ["status", "boardId"] });
  eq("fits the budget", overBudget(out, budget), false);
  eq("is still a string, not JSON", out.trimStart().startsWith("{"), false);
  eq("no character-indexed keys", out.includes('"0":'), false);
  eq("keeps the head of the document", out.startsWith("## Board"), true);
  eq("says how much was cut", out.includes("truncated:"), true);
  eq("names the filters that would narrow it", out.includes("status"), true);
}

group("defect 4 — the envelope must not lie or collide");
{
  const budget = 2_000;
  // bulk_apply returns its OWN `truncated: boolean`. The old key overwrote it.
  const out = capped(
    { results: [{ ok: true }], truncated: true, tasks: rows(200) },
    { budget },
  );
  const parsed = JSON.parse(out);
  eq("the caller's own `truncated` boolean survives", parsed.truncated, true);
  eq("transport metadata lands on its own key", TRUNCATION_KEY in parsed, true);

  // A payload that fits must be byte-identical and carry NO envelope.
  const small = { task: { id: "x", title: "small" } };
  const clean = cappedDetailed(small, { budget });
  eq("a fitting payload is untouched", clean.text, serialize(small));
  eq("…and claims nothing", clean.truncation, undefined);

  // `total` is the caller's to know. Never substitute rows.length.
  const noTotal = cappedDetailed({ tasks: rows(100) }, { budget });
  eq("no invented total", noTotal.truncation?.total, undefined);
  const withTotal = cappedDetailed({ tasks: rows(100) }, { budget, total: 812 });
  eq("a supplied total is reported", withTotal.truncation?.total, 812);
}

group("the ladder — text before rows");
{
  const budget = 4_000;
  // One fat field across few rows: trimming text should keep every row.
  const data = { tasks: rows(6, 20_000) };
  const { text, truncation } = cappedDetailed(data, { budget });
  eq("fits", overBudget(text, budget), false);
  eq("every row survived", JSON.parse(text).tasks.length, 6);
  eq("text was trimmed instead", typeof truncation?.textTrimmedTo, "number");
  eq(
    "and it names the field",
    (truncation?.truncatedFields ?? []).includes("tasks.summary"),
    true,
  );
}

group("the ladder — the rungs below");
{
  const budget = MIN_BUDGET_TOKENS;
  // A 2MB string is NOT a last-resort case: trimming text handles it, and
  // keeping the shape beats erroring. Assert that it degrades that far.
  const huge = capped({ blob: { note: "x".repeat(2_000_000) } }, { budget });
  eq("still fits", overBudget(huge, budget), false);
  eq("a huge string is trimmed, not surrendered", JSON.parse(huge).blob.note.length < 2_000, true);

  // Nothing to trim and nothing to cut — no long strings, no arrays, just
  // 50,000 keys. This is what the last resort is actually for.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
  const last = capped(wide, { budget });
  eq("the irreducible case still fits", overBudget(last, budget), false);
  eq("…and reports an error, not a false success", JSON.parse(last).error, "response_too_large");
  eq("…and describes the shape it gave up on", Array.isArray(JSON.parse(last).shape), true);

  // A budget below the floor is clamped up rather than made impossible.
  const clamped = capped({ tasks: rows(50) }, { budget: 1 });
  eq("a silly budget is clamped, not honoured", overBudget(clamped, MIN_BUDGET_TOKENS), false);
}

group("trimText");
{
  const { data, fields } = trimText({ a: "x".repeat(50), b: { c: "y" } }, 10);
  eq("cuts the long one", (data as { a: string }).a.startsWith("xxxxxxxxxx"), true);
  eq("marks it", (data as { a: string }).a.includes("truncated"), true);
  eq("leaves the short one", (data as { b: { c: string } }).b.c, "y");
  eq("names the cut field", fields, ["a"]);
  eq(
    "array elements collapse to one path, not one per index",
    trimText({ xs: [{ s: "x".repeat(50) }, { s: "y".repeat(50) }] }, 10).fields,
    ["xs.s"],
  );
}

group("preview — the digest teaser");
{
  eq("null stays null", preview(null, 100), null);
  eq("short text is returned whole", preview("Shipped the thing.", 100), "Shipped the thing.");
  eq(
    "a leading heading is stripped so the teaser says something",
    preview("## What shipped\n\nThe demo controller was already in the SDK.", 40),
    "The demo controller was already in the …[trimmed]",
  );
  eq(
    "whitespace collapses",
    preview("a\n\n  b   c", 100),
    "a b c",
  );
  const long = preview(PROSE.repeat(10), 60);
  eq("respects the cap", (long ?? "").length <= 60 + " …[trimmed]".length, true);
  eq("never ends mid-word", /\w$/.test((long ?? "").replace(" …[trimmed]", "")), true);
  eq("marks that there is more", (long ?? "").endsWith("…[trimmed]"), true);
}

group("previewBudget — spend the budget you have");
{
  eq("a quiet day gets the ceiling", previewBudget(8), 600);
  eq("a wide window gets the floor", previewBudget(500), 120);
  eq(
    "a busy day lands in between",
    previewBudget(42) > 120 && previewBudget(42) < 600,
    true,
  );
  eq("more rows never means more text each", previewBudget(100) <= previewBudget(20), true);
  eq("zero rows doesn't divide by zero", Number.isFinite(previewBudget(0)), true);
}

group("the invariant — fuzz");
{
  // Deterministic PRNG: a check that fails only on Tuesdays is worse than none.
  let seed = 20260826;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

  const shape = (): unknown => {
    switch (Math.floor(rnd() * 6)) {
      case 0:
        return rows(Math.floor(rnd() * 200));
      case 1:
        return { tasks: rows(Math.floor(rnd() * 100)), total: 5 };
      case 2:
        return {
          shipped: rows(Math.floor(rnd() * 50)),
          worked: rows(Math.floor(rnd() * 50)),
          drift: { doneNotPlanned: rows(Math.floor(rnd() * 30)) },
        };
      case 3:
        return PROSE.repeat(Math.floor(rnd() * 400) + 1);
      case 4:
        return { note: "x".repeat(Math.floor(rnd() * 200_000)) };
      default:
        return { ok: true, n: Math.floor(rnd() * 1000) };
    }
  };

  let worst = 0;
  let over = 0;
  let unparseable = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const budget = Math.floor(rnd() * (BUDGET_TOKENS - MIN_BUDGET_TOKENS)) + MIN_BUDGET_TOKENS;
    const data = shape();
    const items = pick([undefined, "tasks", "shipped", "nope"]);
    const out = capped(data, { budget, ...(items ? { items } : {}) });
    const est = estimateTokens(out);
    worst = Math.max(worst, est / budget);
    if (est > budget) over++;
    if (typeof data !== "string" && !out.startsWith("{") && !out.startsWith("[")) {
      // a JSON input must come back as JSON, never a sliced fragment
      unparseable++;
    } else if (typeof data !== "string") {
      try {
        JSON.parse(out);
      } catch {
        unparseable++;
      }
    }
  }
  eq(`${N} random shapes x budgets: none over the ceiling`, over, 0);
  eq("every JSON result still parses", unparseable, 0);
  eq(
    `worst case used ≤100% of its budget (was ${(worst * 100).toFixed(1)}%)`,
    worst <= 1,
    true,
  );
}

/* -------------------------------- summary ------------------------------- */

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n\n${failures.join("\n\n")}\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);
process.exit(failures.length ? 1 : 0);
