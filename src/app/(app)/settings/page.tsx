"use client";

import {
  Check,
  PartyPopper,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Badge";
import { AvatarCropper } from "@/components/ui/AvatarCropper";
import { usePeople } from "@/components/PeopleContext";

interface TokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function SettingsPage() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  // The one-time plaintext of a freshly created token (shown once).
  const [fresh, setFresh] = useState<{ token: TokenInfo; plaintext: string } | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // Origin is only known on the client; one-shot read for the MCP command.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only window read
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/tokens");
    if (res.ok) setTokens((await res.json()).tokens);
  }, []);

  // Load tokens on mount (inline so the setState is post-await).
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/tokens");
      if (alive && res.ok) setTokens((await res.json()).tokens);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() || "Claude" }),
      });
      if (res.ok) {
        setFresh(await res.json());
        setLabel("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    if (fresh?.token.id === id) setFresh(null);
    await load();
  }

  const command = (plaintext: string) =>
    `claude mcp add --transport http todo https://to-do-challenger.vercel.app/api/mcp --header "Authorization: Bearer ${plaintext}"`;

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Settings"
        subtitle="Create a personal token and paste the command into Claude Code. Claude will then see and manage only your tasks."
      />

      <div className="max-w-3xl space-y-8 px-8 py-6">
        <ProfileSection />

        <CalendarsSection />

        <TelegramSection />

        {/* Create */}
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-1 text-sm font-semibold">Create a token</h2>
          <p className="mb-4 text-xs text-muted">
            Give it a name so you can tell your devices apart. The token is shown
            once — copy it right away.
          </p>
          <div className="flex gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Laptop"
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
            <button
              onClick={create}
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create token"}
            </button>
          </div>

          {fresh && (
            <div className="mt-4 rounded-lg border border-accent/40 bg-accent-soft/40 p-4">
              <div className="mb-2 text-xs font-medium text-accent">
                New token “{fresh.token.label}” — copy it now, you won’t see it again.
              </div>
              <CopyBox value={fresh.plaintext} mono />
              <div className="mt-3 mb-1 text-xs font-medium text-muted">
                Run this in your terminal:
              </div>
              <CopyBox value={command(fresh.plaintext)} mono />
            </div>
          )}
        </section>

        {/* Existing */}
        <section>
          <h2 className="mb-3 text-sm font-semibold">Your tokens</h2>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted">No tokens yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-5 py-3">
                  <div className="leading-tight">
                    <div className="text-sm font-medium text-fg">{t.label}</div>
                    <div className="text-[11px] text-faint">
                      Created {new Date(t.createdAt).toLocaleDateString()}
                      {t.lastUsedAt
                        ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(t.id)}
                    className="rounded-md px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Telegram — link a chat so you can manage tasks on the go              */
/* -------------------------------------------------------------------- */

function TelegramSection() {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/telegram/link", { method: "POST" });
      const data = await res.json();
      if (res.ok) setLink(data.url);
      else setErr(data.error ?? "Couldn't create a link right now.");
    } catch {
      setErr("Couldn't create a link right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold">Connect Telegram</h2>
      <p className="mb-4 text-xs text-muted">
        Link a Telegram chat to ask about your to-dos and make changes on the go.
        The link is one-time and expires in 15 minutes; only this account is bound.
      </p>
      {!link ? (
        <button
          onClick={connect}
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating link…" : "Connect Telegram"}
        </button>
      ) : (
        <div className="rounded-lg border border-accent/40 bg-accent-soft/40 p-4">
          <div className="mb-2 text-xs font-medium text-accent">
            Open this on the device with Telegram, then tap Start:
          </div>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Open Telegram →
          </a>
          <div className="mt-3">
            <CopyBox value={link} mono />
          </div>
        </div>
      )}
      {err && <p className="mt-3 text-xs text-red-600">{err}</p>}
    </section>
  );
}

/* -------------------------------------------------------------------- */
/* Profile — display name, avatar color, and profile picture             */
/* -------------------------------------------------------------------- */

function ProfileSection() {
  const { me, refresh } = usePeople();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(me?.name ?? "");
  const [color, setColor] = useState(me?.color ?? "#7b68ee");
  const [language, setLanguage] = useState<"en" | "fr">(me?.language ?? "en");
  const [urlDraft, setUrlDraft] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Keep the form in sync if the roster resolves after first paint.
  const [seededFor, setSeededFor] = useState(me?.id);
  if (me && me.id !== seededFor) {
    setSeededFor(me.id);
    setName(me.name);
    setColor(me.color);
    setLanguage(me.language);
  }

  const flash = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);

  const after = useCallback(async () => {
    await refresh();
    router.refresh(); // re-render the server layout so the sidebar updates too
  }, [refresh, router]);

  async function patchProfile(patch: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErr(b.error ?? `Failed (${res.status})`);
        return false;
      }
      await after();
      flash();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function uploadCropped(blob: Blob) {
    setCropFile(null);
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", blob, "avatar.jpg");
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErr(b.error ?? `Failed (${res.status})`);
        return;
      }
      await after();
      flash();
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold">Profile</h2>
      <p className="mb-4 text-xs text-muted">
        Your display name, avatar color, and picture — used everywhere you’re
        shown as an assignee.
      </p>

      <div className="flex flex-wrap items-start gap-5">
        {/* Live preview */}
        <div className="flex flex-col items-center gap-2">
          <Avatar name={name || me.email} size={72} imageUrl={me.avatarUrl} color={color} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-surface-2 disabled:opacity-50"
            >
              {me.avatarUrl ? "Change photo" : "Upload photo"}
            </button>
            {me.avatarUrl ? (
              <button
                type="button"
                onClick={() => patchProfile({ avatarUrl: null })}
                disabled={busy}
                className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) setCropFile(f);
            }}
          />
        </div>

        {/* Fields */}
        <div className="min-w-[220px] flex-1 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Display name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Avatar color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Pick avatar color"
                className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-bg p-1"
              />
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                spellCheck={false}
                aria-label="Hex color"
                className="w-28 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
              />
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as "en" | "fr")}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
            <span className="mt-1 block text-xs text-muted">
              Non-French users get “Work and talk in ENGLISH” appended to prompts.
            </span>
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={() => patchProfile({ name: name.trim(), color, language })}
              disabled={busy || !name.trim() || !/^#[0-9a-fA-F]{6}$/.test(color)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {saved ? (
              <span className="flex items-center gap-1 text-xs text-buff">
                Saved
                <Check aria-hidden size={12} strokeWidth={2.5} />
              </span>
            ) : null}
          </div>

          {/* Paste-URL alternative */}
          <div className="border-t border-border pt-3">
            <span className="mb-1 block text-xs font-medium text-muted">
              …or use an image URL
            </span>
            <div className="flex gap-2">
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://…/photo.jpg"
                className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              <button
                onClick={async () => {
                  if (await patchProfile({ avatarUrl: urlDraft.trim() })) setUrlDraft("");
                }}
                disabled={busy || !urlDraft.trim()}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              >
                Use
              </button>
            </div>
          </div>

          {err ? <p className="text-xs text-nerf">{err}</p> : null}
        </div>
      </div>

      {cropFile ? (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onDone={uploadCropped}
        />
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------- */
/* Calendars — connect Google (shared + personal) for the Calendar view  */
/* -------------------------------------------------------------------- */

interface Conn {
  id: string;
  scope: "shared" | "personal";
  type: "standard" | "holidays";
  ownerName: string;
  googleEmail: string;
  calendarId: string;
  color: string;
  label: string;
  mine: boolean;
}

function CalendarsSection() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [flash, setFlash] = useState<{ ok?: string; err?: string }>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/calendar/connections");
    if (res.ok) setConns((await res.json()).connections ?? []);
  }, []);

  // Load the roster on mount (inline so the setState is post-await).
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/calendar/connections");
      if (alive && res.ok) setConns((await res.json()).connections ?? []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Surface the connect/error flag the OAuth callback appended, then clean the
  // URL. This must read window post-mount (the value only exists on the client
  // after the OAuth redirect), so the one-shot setState here is intentional.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const ok = p.get("calendar_connected");
    const err = p.get("calendar_error");
    if (ok || err) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the OAuth callback's query flag
      setFlash({ ok: ok ?? undefined, err: err ?? undefined });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const shared = conns.find((c) => c.scope === "shared");
  const personal = conns.filter((c) => c.scope === "personal");

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold">Calendars</h2>
      <p className="mb-4 text-xs text-muted">
        Connect Google Calendar to power the Calendar view. Everyone on this
        workspace can see (and add to) the shared calendar plus every connected
        personal calendar.
      </p>

      {flash.ok && (
        <div className="mb-4 flex items-center gap-1.5 rounded-lg border border-buff/40 bg-buff-soft/50 px-3 py-2 text-xs text-buff">
          <PartyPopper aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
          Connected the {flash.ok} calendar.
        </div>
      )}
      {flash.err && (
        <div className="mb-4 rounded-lg border border-nerf/40 bg-nerf-soft/50 px-3 py-2 text-xs text-nerf">
          {flash.err}
        </div>
      )}

      {/* Shared */}
      <div className="mb-4">
        <div className="mb-1 text-xs font-medium text-muted">Shared calendar</div>
        {shared ? (
          <ConnectionRow conn={shared} onChange={load} />
        ) : (
          <a
            href="/api/google/connect?scope=shared"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Connect shared calendar
          </a>
        )}
      </div>

      {/* Personal */}
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Personal calendars</div>
        <ul className="mb-2 space-y-2">
          {personal.map((c) => (
            <li key={c.id}>
              <ConnectionRow conn={c} onChange={load} />
            </li>
          ))}
        </ul>
        <a
          href="/api/google/connect?scope=personal"
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {personal.length ? "Connect another Google account" : "Connect my Google"}
        </a>
      </div>
    </section>
  );
}

/** One connected calendar: color, owner, choose which calendar id, disconnect. */
function ConnectionRow({ conn, onChange }: { conn: Conn; onChange: () => void }) {
  const [options, setOptions] = useState<{ id: string; summary: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadOptions = useCallback(async () => {
    if (options) return;
    const res = await fetch(`/api/calendar/connections/${conn.id}/calendars`);
    if (res.ok) setOptions((await res.json()).calendars ?? []);
  }, [conn.id, options]);

  async function patch(fields: { calendarId?: string; type?: Conn["type"]; label?: string }) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/calendar/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErr(b.error ?? `Failed (${res.status})`);
        return;
      }
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await fetch(`/api/calendar/connections/${conn.id}`, { method: "DELETE" });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2">
      <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: conn.color }} />
      <div className="min-w-0 flex-1 leading-tight">
        {/* Editable name — save on blur or Enter, Escape to revert. */}
        <input
          key={conn.label}
          defaultValue={conn.label}
          disabled={busy}
          aria-label="Calendar name"
          title="Rename this calendar (in-app only)"
          onBlur={(e) => {
            const label = e.currentTarget.value.trim();
            if (label && label !== conn.label) patch({ label });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = conn.label;
              e.currentTarget.blur();
            }
          }}
          className="w-full truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-fg outline-none hover:border-border focus:border-accent focus:bg-surface"
        />
        <div className="truncate px-1 text-[11px] text-faint">{conn.googleEmail}</div>
      </div>
      <select
        value={conn.calendarId}
        onMouseDown={loadOptions}
        onFocus={loadOptions}
        onChange={(e) => patch({ calendarId: e.target.value })}
        disabled={busy}
        className="max-w-[45%] rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      >
        <option value={conn.calendarId}>
          {options?.find((o) => o.id === conn.calendarId)?.summary ?? conn.calendarId}
        </option>
        {options
          ?.filter((o) => o.id !== conn.calendarId)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.summary}
            </option>
          ))}
      </select>
      <select
        value={conn.type}
        onChange={(e) => patch({ type: e.target.value as Conn["type"] })}
        disabled={busy}
        title="Holidays calendars are read-only in the Calendar view and can be managed by Claude via the “holidays” tag."
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      >
        <option value="standard">Standard</option>
        <option value="holidays">Holidays</option>
      </select>
      <button
        onClick={disconnect}
        disabled={busy}
        className="rounded-md px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        Disconnect
      </button>
      {err && <p className="w-full text-xs text-nerf">{err}</p>}
    </div>
  );
}

/** A read-only value with a copy button. */
function CopyBox({ value, mono }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="flex items-stretch gap-2">
      <code
        className={`flex-1 overflow-x-auto whitespace-pre rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </code>
      <button
        onClick={copy}
        className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
