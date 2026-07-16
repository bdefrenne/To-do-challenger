"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext";
import { TaskDetailModal } from "./workspace/TaskDetailModal";
import type { Project } from "@/lib/types";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

const NAV = [
  { href: "/", label: "All tasks", icon: "☰" },
  { href: "/today", label: "Today", icon: "◎" },
  { href: "/calendar", label: "Calendar", icon: "▦" },
];

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  return (
    <WorkspaceProvider>
      <div className="flex min-h-screen">
        <Sidebar user={user} />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
      <TaskDetailModal />
      <Notice />
    </WorkspaceProvider>
  );
}

/** Transient toast for workspace notices (e.g. a concurrent-edit conflict).
 *  Auto-dismisses after a few seconds; click to dismiss sooner. */
function Notice() {
  const { notice, clearNotice } = useWorkspace();
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 4000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <button
        onClick={clearNotice}
        role="status"
        className="pointer-events-auto max-w-md rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg transition-colors hover:bg-surface-2"
      >
        {notice}
      </button>
    </div>
  );
}

function Sidebar({ user }: { user: SessionUser }) {
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

  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          ✓
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            To-do Challenger
          </div>
          <div className="text-[11px] text-faint">Personal workspace</div>
        </div>
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
              <span
                className={`text-base ${active ? "text-accent" : "text-faint"}`}
              >
                {item.icon}
              </span>
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
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {initial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-fg">{user.name}</div>
            <div className="truncate text-[11px] text-faint">{user.email}</div>
          </div>
          <span className="text-faint">▾</span>
        </button>

        {menuOpen ? (
          <div
            role="menu"
            className="absolute bottom-full left-2 right-2 mb-1 z-30 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          >
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
            >
              <span className="text-faint">✦</span>
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
              <span className="text-faint">⏻</span>
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
  const { projects, createProject } = useWorkspace();
  return (
    <div className="mt-4 px-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Projects
        </span>
        <NewProject onCreate={createProject} />
      </div>
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
  const { createBoard } = useWorkspace();
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const boards = project.boards ?? [];
  const projectActive = pathname === `/projects/${project.id}`;

  function submit() {
    if (text.trim()) {
      createBoard(project.id, text.trim());
      setText("");
      setAdding(false);
    }
  }

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="py-1.5 pl-2 pr-1 text-faint hover:text-fg"
          aria-label={open ? "Collapse project" : "Expand project"}
        >
          {open ? "▾" : "▸"}
        </button>
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
          onClick={() => {
            setOpen(true);
            setAdding(true);
          }}
          title="New board"
          className="px-1 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          +
        </button>
      </div>

      {open ? (
        <div className="ml-4 border-l border-border pl-2">
          {boards.map((b) => {
            const active = pathname === `/boards/${b.id}`;
            return (
              <Link
                key={b.id}
                href={`/boards/${b.id}`}
                className={[
                  "block truncate rounded-md px-2 py-1 text-[13px]",
                  active
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                ].join(" ")}
              >
                {b.name}
              </Link>
            );
          })}
          {adding ? (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                else if (e.key === "Escape") {
                  setText("");
                  setAdding(false);
                }
              }}
              onBlur={() => {
                if (!text.trim()) setAdding(false);
              }}
              placeholder="Board name…"
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="block px-2 py-1 text-xs text-faint hover:text-muted"
            >
              + board
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NewProject({ onCreate }: { onCreate: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="New project"
        className="text-faint transition-colors hover:text-accent"
      >
        +
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text.trim()) {
          onCreate(text.trim());
          setText("");
          setEditing(false);
        } else if (e.key === "Escape") {
          setText("");
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (!text.trim()) setEditing(false);
      }}
      placeholder="Project name…"
      className="w-32 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-fg outline-none placeholder:text-faint focus:border-accent"
    />
  );
}
