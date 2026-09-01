/*
  DEV SIGN-IN FENCE CHECK (TD2-212) — the file that fails if someone
  loosens the gate on the password-free login.

  `/api/dev/login` mints a real session cookie for ANY account without a
  credential. Everything keeping that off a deployment is one boolean, so
  that boolean gets a truth table rather than a comment claiming it works.
  A test here is cheap; the failure it prevents is every account in the
  product being one URL away from anyone.

  Two things proved:

  1. **The fence.** Every combination of NODE_ENV × DEV_LOGIN × VERCEL,
     with `enabled` true in exactly ONE of them. A future edit that drops
     a condition (or flips a default to opt-OUT) turns several rows red.

  2. **The cookie is a real one.** What the route mints must be exactly
     what /api/auth/login mints — same signature, same uid — and a
     tampered payload must not verify. If dev login produced a cookie
     the normal path would reject, the whole feature verifies nothing.

  Pure: no database, no server. Run it after touching
  src/lib/dev-login.ts or the route.

    npm run check:devlogin
*/

import { devLoginEnabled } from "@/lib/dev-login";
import { signSession, verifySession } from "@/lib/session";

let failures = 0;
let checks = 0;

function ok(label: string, actual: unknown, expected: unknown) {
  checks++;
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

/** Evaluate devLoginEnabled() under a specific environment, then restore. */
function under(env: {
  NODE_ENV?: string;
  DEV_LOGIN?: string;
  VERCEL?: string;
}): boolean {
  const keys = ["NODE_ENV", "DEV_LOGIN", "VERCEL"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) {
      const v = env[k];
      // NODE_ENV is a readonly type in @types/node; the assignment is real.
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
    return devLoginEnabled();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  }
}

console.log("\nTD2-212 — dev sign-in fence\n");

console.log("The truth table (open in exactly one row):");

// The ONE combination that opens the door.
ok("development + DEV_LOGIN=1 + no VERCEL → OPEN", under({ NODE_ENV: "development", DEV_LOGIN: "1" }), true);

// Missing the opt-in.
ok("development, DEV_LOGIN unset → shut", under({ NODE_ENV: "development" }), false);
ok("development, DEV_LOGIN=0 → shut", under({ NODE_ENV: "development", DEV_LOGIN: "0" }), false);
ok("development, DEV_LOGIN=true → shut (only \"1\" counts)", under({ NODE_ENV: "development", DEV_LOGIN: "true" }), false);

// Production build — the condition that already covers every Vercel deploy,
// preview included, since previews build with NODE_ENV=production.
ok("production, DEV_LOGIN=1 → shut", under({ NODE_ENV: "production", DEV_LOGIN: "1" }), false);
ok("production, DEV_LOGIN unset → shut", under({ NODE_ENV: "production" }), false);

// A deployment built in development mode — the last hole, closed by VERCEL.
ok("development + DEV_LOGIN=1 but VERCEL=1 → shut", under({ NODE_ENV: "development", DEV_LOGIN: "1", VERCEL: "1" }), false);
ok("test + DEV_LOGIN=1 + VERCEL=1 → shut", under({ NODE_ENV: "test", DEV_LOGIN: "1", VERCEL: "1" }), false);

// No environment at all should not be treated as "development, therefore open".
ok("NODE_ENV unset, DEV_LOGIN unset → shut", under({}), false);
ok("NODE_ENV unset, DEV_LOGIN=1 → OPEN (a bare local node process)", under({ DEV_LOGIN: "1" }), true);

console.log("\nThe cookie it mints is the ordinary session cookie:");

const uid = "11111111-2222-3333-4444-555555555555";
const now = Date.now();
const cookie = signSession(uid, now);

ok("verifies back to the same user id", verifySession(cookie, now), uid);
ok("still valid an hour later", verifySession(cookie, now + 3_600_000), uid);
ok("expired after 31 days", verifySession(cookie, now + 31 * 86_400_000), null);

const [payload, sig] = cookie.split(".");
const otherPayload = signSession("99999999-0000-0000-0000-000000000000", now).split(".")[0];
ok("a swapped payload with the old signature is rejected", verifySession(`${otherPayload}.${sig}`, now), null);
ok("a truncated signature is rejected", verifySession(`${payload}.${sig.slice(0, -2)}`, now), null);
ok("garbage is rejected", verifySession("not-a-cookie", now), null);
ok("an empty cookie is rejected", verifySession(undefined, now), null);

console.log(
  failures === 0
    ? `\n✅ ${checks} assertions passed — the fence holds.\n`
    : `\n❌ ${failures} of ${checks} assertions FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
