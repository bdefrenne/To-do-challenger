/*
  ====================================================================
  DEV SIGN-IN FENCE (TD2-212) — the ONE place that decides whether the
  password-free dev login exists.

  `/api/dev/login` hands out a real session cookie for any account with
  no credential at all. That is only ever acceptable on a developer's
  own machine, so the gate must be impossible to get wrong: three
  independent conditions, all server-side, all read here and nowhere
  else. Never re-derive them at a call site, and never mirror them into
  a NEXT_PUBLIC_ flag — a second copy of a fence is a fence that can
  disagree with itself, and the direction it fails is "open".

    1. NODE_ENV !== "production"
       Vercel builds PREVIEW deployments with NODE_ENV=production too,
       not just prod — so this single line already excludes every
       deploy, which is the property TD2-212 asked for.

    2. DEV_LOGIN === "1"
       An explicit opt-in. Off by default, so checking out this repo
       doesn't silently open the door; it has to be typed into a local
       .env file on purpose.

    3. No VERCEL env var
       Closes the last hole: a deployment built in development mode.
       Vercel sets VERCEL=1 on every build and every runtime, prod and
       preview alike.

  Fenced callers answer 404, never 403 — a 403 would confirm the route
  is there.
  ====================================================================
*/

/** True only on a local, explicitly opted-in development server. */
export function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL) return false;
  return process.env.DEV_LOGIN === "1";
}
