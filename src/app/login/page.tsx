"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/Badge";

interface DevUser {
  id: string;
  name: string;
  email: string;
  color: string;
  avatarUrl: string | null;
}

/*
  Development sign-in (TD2-212). There is NO client-side flag guarding this:
  it asks the server for the roster, and a fenced server answers 404, so this
  block renders nothing. The gate lives in devLoginEnabled() and only there —
  a NEXT_PUBLIC_ mirror could disagree with it, and would fail open.
*/
function DevSignIn() {
  const router = useRouter();
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [database, setDatabase] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/dev/login")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setUsers(d.users ?? []);
        setDatabase(d.database ?? null);
      })
      .catch(() => {
        /* fenced, or offline — the block simply doesn't appear */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!users?.length) return null;

  async function signInAs(u: DevUser) {
    setBusy(u.id);
    try {
      const res = await fetch("/api/dev/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: u.id }),
      });
      if (!res.ok) return;
      router.push("/");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed border-border bg-surface p-4">
      <div className="mb-1 text-xs font-medium text-muted">Development sign-in</div>
      {database && (
        <div className="mb-3 text-[11px] text-faint">
          <span className="font-semibold text-amber-600">LIVE DATA</span> · {database}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => signInAs(u)}
            disabled={busy !== null}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <Avatar name={u.name} size={24} imageUrl={u.avatarUrl} color={u.color} />
            <span className="min-w-0">
              <span className="block truncate text-sm text-fg">{u.name}</span>
              <span className="block truncate text-[11px] text-faint">{u.email}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Login failed." }));
        setError(error ?? "Login failed.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-white">
            <Check aria-hidden size={20} strokeWidth={3} />
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight">To-do Challenger</div>
            <div className="text-xs text-faint">Sign in to your workspace</div>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-border bg-surface p-6 shadow-sm"
        >
          <label className="mb-1 block text-xs font-medium text-muted">Email</label>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            placeholder="you@example.com"
          />

          <label className="mb-1 block text-xs font-medium text-muted">Password</label>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            placeholder="••••••••"
          />

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <DevSignIn />
      </div>
    </div>
  );
}
