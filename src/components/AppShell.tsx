"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  WorkspaceProvider,
  useWorkspace,
  type NoticeDetail,
} from "./workspace/WorkspaceContext";
import { TaskDetailModal } from "./workspace/TaskDetailModal";
import { ShortcutsHelp, openShortcutsHelp } from "./workspace/ShortcutsHelp";
import { BoardModal } from "./workspace/BoardModal";
import { ProjectModal } from "./workspace/ProjectModal";
import {
  Archive,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Copy,
  X,
  Keyboard,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Plus,
  Settings,
  Sparkles,
  Sunrise,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { PeopleProvider, usePeople } from "./PeopleContext";
import { Avatar } from "./ui/Badge";
import type { Project, TaskPlacement } from "@/lib/types";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Avatar ring/stroke color (hex). */
  color: string;
  /** Profile picture URL, or null (initials fallback). */
  avatarUrl: string | null;
  /** Working language ("en" | "fr"). */
  language: "en" | "fr";
}

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "All tasks", icon: ListTodo },
  { href: "/today", label: "Today", icon: Sunrise },
  { href: "/day", label: "Finish work", icon: CircleDot },
  { href: "/canvas", label: "Canvas", icon: LayoutDashboard },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/archived", label: "Archived", icon: Archive },
  { href: "/trash", label: "Trash", icon: Trash2 },
];

const SIDEBAR_KEY = "sidebar:open";

/** The sidebar's open/closed flag, kept in localStorage so the choice survives
 *  reloads (and stays in step across tabs). Read through
 *  `useSyncExternalStore` so SSR always renders it closed — the default — and
 *  the stored value is picked up right after hydration. */
const sidebarListeners = new Set<() => void>();

function subscribeSidebar(onChange: () => void) {
  sidebarListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    sidebarListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readSidebarOpen() {
  return localStorage.getItem(SIDEBAR_KEY) === "1";
}

function writeSidebarOpen(open: boolean) {
  localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
  for (const cb of sidebarListeners) cb();
}

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  const sidebarOpen = useSyncExternalStore(
    subscribeSidebar,
    readSidebarOpen,
    () => false,
  );
  const toggleSidebar = () => writeSidebarOpen(!sidebarOpen);

  return (
    <PeopleProvider me={user}>
      <WorkspaceProvider meName={user.name} meId={user.id}>
        <div className="flex min-h-screen">
          {sidebarOpen ? (
            <Sidebar user={user} onClose={toggleSidebar} />
          ) : (
            <SidebarRail onOpen={toggleSidebar} />
          )}
          {/* `overflow-x-clip`, NOT `-hidden`: `hidden` makes this a scroll
              container (and per spec promotes overflow-y to `auto`). Nothing
              here should ever scroll — the one wide surface, TaskTable, brings
              its own `overflow-x-auto` — but a focusable element out in a
              clipped subtree (the canvas is full of them) makes the browser
              scroll THIS box to reveal it, and Chrome then restores that offset
              across reloads, leaving the canvas translated off-screen with no
              way to recover. `clip` clips identically and is unscrollable, so
              the offset can't exist. See TD-133. */}
          <main className="min-w-0 flex-1 overflow-x-clip">{children}</main>
        </div>
        <TaskDetailModal />
        <GlobalProjectSettings />
        <ShortcutsHelp />
        <Notice />
        <DeleteUndoToast />
        <SendUndoToast />
        <CompleteBranchPrompt />
      </WorkspaceProvider>
    </PeopleProvider>
  );
}

/** The single project-settings modal opened from anywhere via the workspace's
 *  `openProjectSettings(id)` — e.g. the assignee picker's "Edit Project
 *  Members" button. Distinct from the sidebar gear's own local modal. */
function GlobalProjectSettings() {
  const { projects, projectSettingsId, closeProjectSettings } = useWorkspace();
  if (!projectSettingsId) return null;
  const project = projects.find((p) => p.id === projectSettingsId);
  if (!project) return null;
  return (
    <ProjectModal mode="edit" project={project} onClose={closeProjectSettings} />
  );
}

/** How a notice's detail reads once pasted into a bug report — plain text, in
 *  the order someone reading it needs: what the app said, when and where, then
 *  one block per failed write (TD2-203). */
function formatNoticeReport(message: string, detail: NoticeDetail): string {
  const lines = [
    "To-do Challenger — save error",
    `Message: ${message}`,
    `Kind: ${detail.kind}`,
    `Time: ${detail.at}`,
  ];
  if (typeof window !== "undefined") {
    lines.push(`Page: ${window.location.href}`);
    lines.push(`Browser: ${navigator.userAgent}`);
  }
  if (detail.extra) lines.push(`Note: ${detail.extra}`);
  detail.items.forEach((it, i) => {
    lines.push("");
    const name = it.taskTitle
      ? `“${it.taskTitle}”${it.taskRef ? ` (${it.taskRef})` : ""}`
      : (it.taskRef ?? "(no task in this request)");
    lines.push(`${i + 1}) Task: ${name}`);
    if (it.taskId) lines.push(`   Task id: ${it.taskId}`);
    if (it.fields?.length) lines.push(`   Fields: ${it.fields.join(", ")}`);
    if (it.method || it.path)
      lines.push(
        `   Request: ${it.method ?? "?"} ${it.path ?? "?"}${it.status ? ` → ${it.status}` : ""}`,
      );
    if (it.error) lines.push(`   Error: ${it.error}`);
  });
  return lines.join("\n");
}

/** Put text on the clipboard. `navigator.clipboard` needs a secure context and
 *  isn't there in every browser this runs in, so fall back to the old selection
 *  trick rather than failing silently on the one action the toast exists for. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Transient toast for workspace notices (e.g. a concurrent-edit conflict).
 *
 *  A notice that carries `detail` is CLICKABLE (TD2-203): it opens into the full
 *  story — which card failed, which fields, which request, what the server said
 *  — with a Copy button that puts the lot on the clipboard. Before that, a
 *  failed save was a sentence that vanished in 4s and left nothing to report
 *  with but the browser console.
 *
 *  Auto-dismiss follows the same logic: 4s for a bare sentence, longer when
 *  there's something to read, and never while it's open. */
function Notice() {
  const { notice, clearNotice } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = notice?.detail ?? null;

  // A new notice replaces the old one in place, so the panel must not stay open
  // showing the previous failure's detail. Adjusted during render rather than in
  // an effect: the reset has to be visible in the SAME paint as the new message,
  // or the panel shows one failure's detail under another's headline.
  const [shown, setShown] = useState(notice);
  if (shown !== notice) {
    setShown(notice);
    setOpen(false);
    setCopied(false);
  }

  useEffect(() => {
    if (!notice || open) return;
    const t = setTimeout(clearNotice, detail ? 10000 : 4000);
    return () => clearTimeout(t);
  }, [notice, detail, open, clearNotice]);

  if (!notice) return null;
  const { message } = notice;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[300] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface text-sm text-fg shadow-lg"
      >
        <div className="flex items-start gap-2 px-4 py-2.5">
          <button
            onClick={() => (detail ? setOpen((o) => !o) : clearNotice())}
            className="min-w-0 flex-1 text-left"
            aria-expanded={detail ? open : undefined}
          >
            <span>{message}</span>
            {detail && (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-faint">
                {open ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                {open ? "Hide details" : "Show details"}
                {detail.items.length > 1 && ` (${detail.items.length})`}
              </span>
            )}
          </button>
          <button
            onClick={clearNotice}
            title="Dismiss"
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-faint transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {detail && open && (
          <div className="max-h-72 overflow-y-auto border-t border-border bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2 pb-2">
              <span className="text-xs text-faint">{new Date(detail.at).toLocaleString()}</span>
              <button
                onClick={async () => {
                  const ok = await copyText(formatNoticeReport(message, detail));
                  setCopied(ok);
                }}
                className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy details"}
              </button>
            </div>
            {detail.extra && <p className="pb-2 text-xs text-faint">{detail.extra}</p>}
            <ul className="space-y-2.5">
              {detail.items.map((it, i) => (
                <li key={i} className="space-y-0.5 text-xs">
                  <p className="font-medium text-fg">
                    {it.taskTitle ?? it.taskRef ?? "This change"}
                    {it.taskTitle && it.taskRef && (
                      <span className="ml-1.5 font-normal text-faint">{it.taskRef}</span>
                    )}
                  </p>
                  {!!it.fields?.length && (
                    <p className="text-faint">
                      Didn’t save: <span className="text-fg">{it.fields.join(", ")}</span>
                    </p>
                  )}
                  {(it.method || it.path) && (
                    <p className="break-all font-mono text-[11px] text-faint">
                      {it.method} {it.path}
                      {it.status ? ` → ${it.status}` : ""}
                    </p>
                  )}
                  {it.error && <p className="break-words text-faint">{it.error}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Deleted · Undo" toast for canvas task deletes still inside their undo
 *  window. Clears itself when the window lapses (delete commits) or on Undo.
 *  Undo takes back EVERY task in the window, not just the newest — see
 *  `undoDelete`; the toast counts them so it's clear how many come back. */
function DeleteUndoToast() {
  const { pendingDeletes, undoDelete } = useWorkspace();
  if (!pendingDeletes.length) return null;
  const last = pendingDeletes[pendingDeletes.length - 1];
  // Done tasks are archived, not deleted; a run of presses can be a mix of both,
  // and then neither verb is true of all of them.
  const mixed = pendingDeletes.some((d) => d.mode !== last.mode);
  const verb = mixed ? "Removed" : last.mode === "archive" ? "Archived" : "Deleted";
  const label =
    pendingDeletes.length > 1
      ? `${verb} ${pendingDeletes.length} tasks`
      : `${verb} “${last.title}”`;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[300] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="max-w-[16rem] truncate">{label}</span>
        <button
          onClick={() => undoDelete()}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Undo
          <kbd className="rounded bg-surface-3 px-1 text-[9px] font-semibold leading-none text-faint">
            ⌘Z
          </kbd>
        </button>
      </div>
    </div>
  );
}

const SEND_LABEL: Record<TaskPlacement, string> = {
  inbox: "Inbox",
  thisWeek: "This week",
  backlog: "Backlog",
  later: "Later",
  doneThisWeek: "Done this week",
};

/** "Sent … · Undo" toast for the canvas hover arrows (↑/→/↓ → THIS WEEK /
 *  BACKLOG / LATER). A send commits immediately, so unlike `DeleteUndoToast`
 *  there's no grace window to show — this just fires on every send, no
 *  debounce, overwriting whatever it was already showing. */
function SendUndoToast() {
  const { pendingSend, undoSend, clearPendingSend } = useWorkspace();
  useEffect(() => {
    if (!pendingSend) return;
    const t = setTimeout(clearPendingSend, 4000);
    return () => clearTimeout(t);
  }, [pendingSend, clearPendingSend]);

  if (!pendingSend) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-[300] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="max-w-[16rem] truncate">
          Sent “{pendingSend.title}” to {SEND_LABEL[pendingSend.to]}
        </span>
        <button
          onClick={undoSend}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Undo
        </button>
      </div>
    </div>
  );
}

/**
 * The answer to a refused completion: this task still has unfinished subtasks.
 *
 * A question, not a notice — so unlike the toasts above it does NOT auto-dismiss,
 * and it offers the only path that closes a branch in one action
 * (`completeBranch` → `withSubtasks`). Without it the rule is a dead end: DELETE
 * on a Review card means "complete", so a parent with open children could be
 * refused with nothing to do about it but hunt down each child.
 *
 * "Not now" leaves everything exactly as it was — the refused write never landed.
 */
function CompleteBranchPrompt() {
  const { pendingComplete, completeBranch, clearPendingComplete } = useWorkspace();
  if (!pendingComplete) return null;
  const { taskId, taskTitle, openCount } = pendingComplete;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-[300] flex justify-center px-4">
      <div
        role="alertdialog"
        aria-label="Unfinished subtasks"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="min-w-0">
          <span className="max-w-[18rem] truncate font-medium">{taskTitle}</span>{" "}
          <span className="text-muted">
            still has {openCount} unfinished subtask{openCount === 1 ? "" : "s"}.
          </span>
        </span>
        <button
          onClick={() => completeBranch(taskId)}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Complete all {openCount}
        </button>
        <button
          onClick={clearPendingComplete}
          className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** Collapsed stand-in for the sidebar: a narrow gutter holding just the button
 *  that brings it back, so page content never sits under the toggle. */
function SidebarRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="sticky top-0 flex h-screen w-11 shrink-0 flex-col items-center py-4">
      <button
        onClick={onOpen}
        title="Show sidebar"
        aria-label="Show sidebar"
        aria-expanded={false}
        className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        »
      </button>
    </div>
  );
}

function Sidebar({ user, onClose }: { user: SessionUser; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  // Prefer the live roster entry so a just-saved picture/color shows without a
  // full reload; fall back to the server-rendered session user.
  const { me } = usePeople();
  const identity = me ?? user;
  return (
    <aside className="sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white">
          <Check aria-hidden size={18} strokeWidth={3} />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            To-do Challenger
          </div>
          <div className="text-[11px] text-faint">Personal workspace</div>
        </div>
        <button
          onClick={onClose}
          title="Hide sidebar"
          aria-label="Hide sidebar"
          aria-expanded
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
        >
          «
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-3 py-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-fg",
              ].join(" ")}
            >
              <item.icon
                aria-hidden
                size={16}
                strokeWidth={active ? 2.25 : 1.75}
                className={active ? "text-accent" : "text-faint"}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <ProjectsNav />

      <div ref={menuRef} className="relative mt-auto border-t border-border p-2">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <Avatar
            name={identity.name || identity.email}
            size={32}
            imageUrl={identity.avatarUrl}
            color={identity.color}
          />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-fg">{identity.name}</div>
            <div className="truncate text-[11px] text-faint">{identity.email}</div>
          </div>
          <ChevronDown aria-hidden size={14} strokeWidth={2} className="text-faint" />
        </button>

        {menuOpen ? (
          <div
            role="menu"
            className="absolute bottom-full left-2 right-2 mb-1 z-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                openShortcutsHelp();
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
            >
              <span className="flex items-center gap-2">
                <Keyboard aria-hidden size={14} strokeWidth={1.75} className="text-faint" />
                Keyboard shortcuts
              </span>
              <kbd className="rounded bg-surface-3 px-1 text-[10px] font-semibold leading-none text-faint">
                ?
              </kbd>
            </button>
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
            >
              <Sparkles aria-hidden size={14} strokeWidth={1.75} className="text-faint" />
              Settings
            </Link>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              <LogOut aria-hidden size={14} strokeWidth={1.75} className="text-faint" />
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** Projects → Boards tree with inline create controls. */
function ProjectsNav() {
  const pathname = usePathname();
  const { projects } = useWorkspace();
  const [creating, setCreating] = useState(false);
  return (
    <div className="mt-4 px-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Projects
        </span>
        <button
          onClick={() => setCreating(true)}
          title="New project"
          className="text-faint transition-colors hover:text-accent"
        >
          +
        </button>
      </div>
      {creating ? (
        <ProjectModal mode="create" onClose={() => setCreating(false)} />
      ) : null}
      <div className="max-h-[42vh] space-y-0.5 overflow-y-auto">
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-xs text-faint">No projects yet.</p>
        ) : (
          projects.map((p) => (
            <ProjectRow key={p.id} project={p} pathname={pathname} />
          ))
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, pathname }: { project: Project; pathname: string }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const boards = project.boards ?? [];
  const projectActive = pathname === `/projects/${project.id}`;

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="py-1.5 pl-1 pr-0.5 text-faint hover:text-fg"
          aria-label={open ? "Collapse project" : "Expand project"}
        >
          {open ? (
            <ChevronDown aria-hidden size={13} strokeWidth={2} />
          ) : (
            <ChevronRight aria-hidden size={13} strokeWidth={2} />
          )}
        </button>
        <Avatar name={project.name} size={16} imageUrl={project.image} color={project.color} />
        <Link
          href={`/projects/${project.id}`}
          className={[
            "flex-1 truncate py-1.5 text-sm",
            projectActive ? "font-medium text-accent" : "text-muted hover:text-fg",
          ].join(" ")}
        >
          {project.name}
        </Link>
        <button
          onClick={() => setEditing(true)}
          title="Project settings"
          className="px-1 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          <Settings aria-hidden size={13} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => {
            setOpen(true);
            setAdding(true);
          }}
          title="New board"
          className="px-1 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          <Plus aria-hidden size={13} strokeWidth={2} />
        </button>
      </div>

      {editing ? (
        <ProjectModal
          mode="edit"
          project={project}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {open ? (
        <div className="ml-4 border-l border-border pl-2">
          {boards.map((b) => {
            const active = pathname === `/boards/${b.id}`;
            return (
              <Link
                key={b.id}
                href={`/boards/${b.id}`}
                className={[
                  "flex items-center gap-2 truncate rounded-md px-2 py-1 text-[13px]",
                  active
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                ].join(" ")}
              >
                <Avatar name={b.name} size={16} imageUrl={b.image} color={b.color} />
                <span className="truncate">{b.name}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {adding ? (
        <BoardModal
          mode="create"
          projectId={project.id}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

