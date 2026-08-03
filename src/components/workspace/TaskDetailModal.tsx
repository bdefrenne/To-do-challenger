"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Task,
  TaskLogEntry,
  Note,
  TaskCommit,
  Importance,
} from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Markdown } from "@/components/ui/Markdown";
import { PointsChip } from "@/components/ui/Badge";
import { PersonAvatar } from "@/components/PersonAvatar";
import { usePeople } from "@/components/PeopleContext";
import { formatTime, formatShortDate, formatDue } from "@/lib/format";
import { STATUS_LABEL, RECURRENCE_LABEL } from "@/lib/statuses";
import { IMPORTANCE_ORDER, IMPORTANCE_LABEL } from "@/lib/importance";
import { StatusPill } from "./StatusPill";
import { StatusSelect } from "./StatusSelect";
import { AssigneeEditor } from "./AssigneeEditor";
import { useWorkspace } from "./WorkspaceContext";

const LOG_ICON: Record<TaskLogEntry["kind"], string> = {
  created: "✦",
  status: "↻",
  moved: "⇄",
  nested: "⤵",
  started: "▶",
  paused: "⏸",
  done: "✓",
  reopened: "↺",
  comment: "💬",
  attached: "📎",
  updated: "✎",
};

/** How each surface reads in the activity attribution line ("via …"). */
const SOURCE_LABEL: Record<NonNullable<TaskLogEntry["source"]>, string> = {
  ui: "UI",
  api: "API",
  mcp: "Claude",
};

const LOG_COLOR: Record<TaskLogEntry["kind"], string> = {
  created: "text-new",
  status: "text-accent",
  moved: "text-accent",
  nested: "text-accent",
  started: "text-new",
  paused: "text-muted",
  done: "text-buff",
  reopened: "text-adjust",
  comment: "text-muted",
  attached: "text-muted",
  updated: "text-accent",
};

/** Wrapper: renders one detail modal per entry in the open-task stack, so
 *  subtasks (and any task click) stack on top and nest indefinitely. Rendered
 *  once globally (in AppShell); the stack + its URL sync live in WorkspaceContext. */
export function TaskDetailModal() {
  const { openTaskIds } = useWorkspace();
  if (!openTaskIds.length) return null;
  return (
    <>
      {openTaskIds.map((id, i) => (
        <TaskDetailLevel
          key={id}
          taskId={id}
          depth={i}
          isTop={i === openTaskIds.length - 1}
        />
      ))}
    </>
  );
}

/** A single level of the task-detail modal stack. */
function TaskDetailLevel({
  taskId,
  depth,
  isTop,
}: {
  taskId: string;
  depth: number;
  isTop: boolean;
}) {
  const {
    openTask,
    closeTask,
    addSubtask,
    taskMap,
    logs,
    notes,
    commits,
    nodeById,
    setStatus,
    toggleDone,
    childrenOf,
    addComment,
    taskPrompt,
    addAttachment,
    removeAttachment,
    editTask,
    editTaskLive,
    flushEdits,
    projects,
    openProjectSettings,
  } = useWorkspace();
  const { resolveById } = usePeople();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState("");
  // Which attachment is featured (shown full-width in the panel, and full-size
  // in the lightbox). One index drives both, so selecting persists across open/close.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Copy buttons: which one just copied (shows "✓ Copied"), and which is
  // awaiting a server round-trip (shows a spinner). Keys: link/analyze/work/both.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Inline "add subtask" composer.
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [addingSub, setAddingSub] = useState(false);
  // Inline description editor: rendered Markdown by default, raw source on edit.
  // Edits autosave (debounced) — no Save/Cancel; ESC commits + exits edit mode.
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descCopied, setDescCopied] = useState(false);
  const descSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each stack level is a fresh component instance (keyed by task id in the
  // wrapper), so the composer/gallery state above is naturally per-task — no
  // reset-on-switch effect needed.

  // Keyboard: Escape closes the lightbox (if open) else this modal; when the
  // lightbox is open, ←/→ step the featured image. Only the topmost level
  // listens, so Escape pops one level at a time instead of collapsing the stack.
  useEffect(() => {
    if (!isTop) return;
    const count = (taskMap[taskId]?.attachments ?? []).length;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setLightboxOpen(false);
        } else if (e.key === "ArrowRight" && count > 1) {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % count);
        } else if (e.key === "ArrowLeft" && count > 1) {
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + count) % count);
        }
        return;
      }
      if (e.key === "Escape") closeTask();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isTop, taskId, closeTask, lightboxOpen, taskMap]);

  // Paste an image anywhere while the topmost modal is open (Ctrl/⌘+V).
  useEffect(() => {
    if (!isTop) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            setUploading(true);
            addAttachment(taskId, file).finally(() => setUploading(false));
          }
          break;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [isTop, taskId, addAttachment]);

  const task = taskMap[taskId];
  const node = nodeById(taskId);
  // Task may not be loaded yet (e.g. hydrating the stack from the URL on
  // refresh); render nothing for this level until it arrives.
  if (!task || !node) return null;

  // The project this task belongs to (if any) — its member set scopes the
  // assignee picker. `projectId` is set whenever the task is on a board too.
  const taskProject = task.projectId
    ? projects.find((p) => p.id === task.projectId)
    : undefined;

  const allEntries = logs[taskId] ?? [];
  // Comments are their own conversation thread (oldest → newest, chat order);
  // everything else stays in the Activity timeline (newest first).
  const comments = allEntries
    .filter((e) => e.kind === "comment")
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  // The Activity timeline unifies two sources: auto-generated log entries and
  // recorded decisions (kept in task_notes) — the decision text shows inline,
  // interleaved chronologically. Each item precomputes its icon/color so the
  // render loop stays source-agnostic.
  const activity = [
    ...allEntries
      .filter((e) => e.kind !== "comment")
      .map((e) => {
        // Prefer the real acting user (actorId); fall back to the legacy author
        // string on rows written before attribution existed.
        const person = e.actorId ? resolveById(e.actorId) : undefined;
        const who = person?.name ?? e.author ?? undefined;
        const via = e.source
          ? SOURCE_LABEL[e.source]
          : e.author === "Claude" // legacy MCP rows had no source
            ? "Claude"
            : undefined;
        return {
          id: e.id,
          at: e.at,
          icon: LOG_ICON[e.kind],
          color: LOG_COLOR[e.kind],
          message: e.message,
          who,
          via,
          avatarName: person?.name ?? e.author ?? undefined,
        };
      }),
    ...(notes[taskId] ?? [])
      .filter((n) => n.type === "decision")
      .map((n) => ({
        id: `note-${n.id}`,
        at: n.createdAt,
        icon: "🎯",
        color: "text-accent",
        message: n.note,
        who: undefined as string | undefined,
        via: undefined as string | undefined,
        avatarName: undefined as string | undefined,
      })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const kids = childrenOf(taskId);
  const done = node.status === "done";
  const due = task.dueDate ? formatDue(task.dueDate) : null;
  const attachments = task.attachments ?? [];
  // Clamp against removals so the featured index is always valid.
  const featuredIndex = Math.min(selectedIndex, Math.max(0, attachments.length - 1));
  const featured = attachments[featuredIndex];

  const submitComment = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    addComment(taskId, text);
  };

  const startEditDesc = () => {
    setDescDraft(task.description ?? "");
    setEditingDesc(true);
  };
  const autoSizeDesc = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // Empty string clears it — the task PATCH schema takes a string, not null,
  // and `""` reads as falsy so the section falls back to "+ Add description".
  // `editTaskLive` is instant for other viewers; the Postgres write is batched.
  const saveDesc = (value: string) => {
    editTaskLive(taskId, { description: value.trim() });
  };
  // Autosave keystrokes on a debounce so peers get the delta soon after you pause.
  const scheduleDescSave = (value: string) => {
    if (descSaveTimer.current) clearTimeout(descSaveTimer.current);
    descSaveTimer.current = setTimeout(() => {
      descSaveTimer.current = null;
      saveDesc(value);
    }, 500);
  };
  // Commit the pending draft immediately (ESC / blur), cancelling any debounce,
  // and force the batched Postgres write now so leaving the field persists it.
  const flushDescSave = () => {
    if (descSaveTimer.current) {
      clearTimeout(descSaveTimer.current);
      descSaveTimer.current = null;
    }
    saveDesc(descDraft);
    void flushEdits();
  };
  const copyDesc = async () => {
    if (!task.description) return;
    try {
      await navigator.clipboard?.writeText(task.description);
      setDescCopied(true);
      setTimeout(() => setDescCopied(false), 2000);
    } catch (e) {
      console.error("[modal] copy description failed", e);
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // allow re-picking the same file
    if (!files.length) return;
    setUploading(true);
    (async () => {
      for (const f of files) await addAttachment(taskId, f);
    })().finally(() => setUploading(false));
  };

  const lightboxItem = lightboxOpen ? featured : null;

  // Produce a string (sync or via the server) and copy it, flashing "✓ Copied"
  // on the matching button. Guards against overlapping clicks.
  const runCopy = async (key: string, produce: () => string | Promise<string>) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const text = await produce();
      await navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    } catch (e) {
      console.error("[modal] copy failed", key, e);
    } finally {
      setBusyKey(null);
    }
  };

  // The "task link & info" block: code + title, status, full description, and a
  // deep link that reopens this task (?tasks=<id>, see WorkspaceContext).
  const buildInfo = (): string => {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}${window.location.pathname}?tasks=${taskId}`
        : "";
    const codeStr = task.code ?? task.ref ?? "";
    const header = codeStr ? `${codeStr} — ${task.title}` : task.title;
    const body = task.description?.trim() || "(no description)";
    return `${header}\nStatus: ${STATUS_LABEL[node.status]}\n\n${body}\n\n${url}`;
  };

  return (
    <>
    <div
      className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-6 backdrop-blur-sm"
      // Z-index scale (app-wide): chrome 20 · cursors 30 · dropdowns/popovers
      // 40 · primary modals 100 (+10 per nesting depth) · secondary modals 200
      // · toast 300. Base 100 keeps the task modal above the z-40 quick-edit
      // popovers (which portal to <body> and would otherwise tie at z-50).
      style={{ zIndex: 100 + depth * 10 }}
      onClick={closeTask}
    >
      <div
        className="mt-12 w-full max-w-[1090px] rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-border px-5 py-4">
          {/* Top row: id/phase left · workflow + copy + close right */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {task.code ? (
                <span
                  className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted"
                  title={task.refLocked ? "Locked code" : "Soft code — not locked yet"}
                >
                  {task.code}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant={done ? "success" : "primary"}
                size="sm"
                onClick={() => toggleDone(taskId)}
              >
                {done ? "✓ Done" : "Mark done"}
              </Button>
              <CopyButton
                label="🔗 Link"
                title="Copy the task's link + info (code, title, status, description)"
                busy={busyKey === "link"}
                copied={copiedKey === "link"}
                onClick={() => runCopy("link", buildInfo)}
              />
              <CopyButton
                label="🔍 Analyze"
                title="Copy a prompt to analyze this task (locks the code)"
                busy={busyKey === "analyze"}
                copied={copiedKey === "analyze"}
                onClick={() => runCopy("analyze", () => taskPrompt(taskId, "analyze"))}
              />
              <CopyButton
                label="📋 Plan"
                title="Copy a prompt to write the technical plan (needs an analysis first)"
                busy={busyKey === "plan"}
                copied={copiedKey === "plan"}
                onClick={() => runCopy("plan", () => taskPrompt(taskId, "plan"))}
              />
              <CopyButton
                label="🔨 Work"
                title="Lock the code and copy a ready-to-paste work prompt"
                busy={busyKey === "work"}
                copied={copiedKey === "work"}
                onClick={() => runCopy("work", () => taskPrompt(taskId, "work"))}
              />
              <CopyButton
                label="🔍→🔨 Both"
                title="Lock the code and copy an analyze-then-work prompt"
                busy={busyKey === "both"}
                copied={copiedKey === "both"}
                onClick={() => runCopy("both", () => taskPrompt(taskId, "analyze-work"))}
              />
              <button
                onClick={closeTask}
                className="rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {/* Second row: title */}
          <h2 className="text-lg font-semibold tracking-tight">{task.title}</h2>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_390px]">
          {/* Left: details */}
          <div className="min-w-0 space-y-5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onPickFiles}
            />

            {/* description — rendered Markdown; click Edit for the raw source */}
            <div>
              <div className="flex items-center justify-between">
                <SectionLabel>Description</SectionLabel>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-2 disabled:opacity-50"
                  >
                    {uploading ? "Uploading…" : "+ Add image"}
                  </button>
                  {!editingDesc && task.description ? (
                    <button
                      type="button"
                      onClick={copyDesc}
                      className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-2"
                    >
                      {descCopied ? "✓ Copied" : "⧉ Copy"}
                    </button>
                  ) : null}
                </div>
              </div>
              {editingDesc ? (
                <div className="mt-1">
                  <textarea
                    ref={autoSizeDesc}
                    value={descDraft}
                    onChange={(e) => {
                      setDescDraft(e.target.value);
                      autoSizeDesc(e.target);
                      scheduleDescSave(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      // ESC commits the draft and exits edit mode — but must NOT
                      // reach the document-level handler that closes the modal, so
                      // a second ESC (now out of edit mode) is what closes it.
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        flushDescSave();
                        setEditingDesc(false);
                      }
                    }}
                    // Clicking away (overlay, ✕, elsewhere) commits the draft too.
                    onBlur={flushDescSave}
                    autoFocus
                    rows={3}
                    placeholder="Describe this task…  (Markdown supported)"
                    className="w-full resize-none overflow-hidden rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none focus:border-accent"
                  />
                </div>
              ) : task.description ? (
                <div
                  onDoubleClick={startEditDesc}
                  title="Double-click to edit"
                  className="mt-1"
                >
                  <Markdown>{task.description}</Markdown>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditDesc}
                  className="mt-1 text-xs font-medium text-accent hover:underline"
                >
                  + Add description
                </button>
              )}
            </div>

            {/* subtasks */}
            <div>
              <SectionLabel>Sub-tasks · {kids.length}</SectionLabel>
              {kids.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {kids.map((k) => (
                    <li
                      key={k.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
                    >
                      <StatusPill status={k.status} onChange={(s) => setStatus(k.id, s)} compact />
                      <button
                        onClick={() => openTask(k.id)}
                        className="truncate text-left text-fg hover:underline"
                      >
                        {taskMap[k.id]?.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* add subtask — creates the child and opens its modal on top */}
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && subtaskTitle.trim() && !addingSub) {
                      const title = subtaskTitle.trim();
                      setSubtaskTitle("");
                      setAddingSub(true);
                      addSubtask(taskId, title).finally(() => setAddingSub(false));
                    }
                  }}
                  disabled={addingSub}
                  placeholder="Add a subtask…"
                  className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
                />
                {addingSub ? (
                  <span
                    className="h-3.5 w-3.5 animate-spin rounded-full border border-faint border-t-transparent"
                    aria-label="Adding subtask"
                  />
                ) : null}
              </div>
            </div>

            {/* workflow — summaries, notes (incl. decisions), commits */}
            <WorkflowSection
              task={task}
              notes={notes[taskId] ?? []}
              commits={commits[taskId] ?? []}
            />

            {/* attachments — hidden entirely when there are none */}
            {featured ? (
              <div>
                <SectionLabel>Attachments · {attachments.length}</SectionLabel>
                <div className="mt-2 space-y-2">
                  {/* Featured — full width; click to open full screen. */}
                  <div className="group relative overflow-hidden rounded-lg border border-border bg-surface-2">
                    <button
                      type="button"
                      onClick={() => setLightboxOpen(true)}
                      className="block w-full cursor-zoom-in"
                      aria-label={`View ${featured.filename} full screen`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={featured.url}
                        alt={featured.filename}
                        className="max-h-80 w-full object-contain"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(taskId, featured.id)}
                      className="absolute right-1.5 top-1.5 hidden rounded-full bg-slate-900/70 px-1.5 py-0.5 text-[11px] leading-none text-white group-hover:block"
                      aria-label={`Remove ${featured.filename}`}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Thumbnail strip — click to feature the image above. */}
                  {attachments.length > 1 ? (
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((a, i) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setSelectedIndex(i)}
                          aria-current={i === featuredIndex}
                          className={`h-14 w-14 shrink-0 overflow-hidden rounded-md border transition ${
                            i === featuredIndex
                              ? "border-accent ring-1 ring-accent"
                              : "border-border opacity-60 hover:opacity-100"
                          }`}
                          aria-label={`Show ${a.filename}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.url}
                            alt={a.filename}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* comments — the conversation thread (you ⇄ Claude) */}
            <div>
              <SectionLabel>Comments · {comments.length}</SectionLabel>
              <div className="mt-2 space-y-3">
                {comments.map((c) => {
                    const author = c.author ?? "You";
                    const mine = author === "You";
                    return (
                      <div
                        key={c.id}
                        className={`flex gap-2 ${mine ? "flex-row-reverse" : "flex-row"}`}
                      >
                        <PersonAvatar name={author} size={24} />
                        <div
                          className={`flex min-w-0 max-w-[80%] flex-col ${mine ? "items-end" : "items-start"}`}
                        >
                          <div
                            className={`flex items-baseline gap-2 text-[11px] text-faint ${mine ? "flex-row-reverse" : ""}`}
                          >
                            <span className="font-medium text-muted">{author}</span>
                            <span>{formatTime(c.at)}</span>
                          </div>
                          <div
                            className={`mt-0.5 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm text-fg ${
                              mine
                                ? "rounded-tr-sm bg-accent/10"
                                : "rounded-tl-sm bg-surface-2"
                            }`}
                          >
                            {c.message}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
              {/* composer */}
              <div className="mt-3 flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitComment();
                    }
                  }}
                  rows={2}
                  placeholder="Write a comment…  (Enter to send · Shift+Enter for a new line)"
                  className="min-h-[38px] flex-1 resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={submitComment}
                  disabled={!draft.trim()}
                >
                  Post
                </Button>
              </div>
            </div>

            {/* activity log */}
            <div>
              <SectionLabel>Activity · {activity.length}</SectionLabel>
              <ol className="relative mt-2 space-y-1 before:absolute before:left-[11px] before:top-1 before:bottom-1 before:w-px before:bg-border">
                {activity.map((e) => (
                  <li key={e.id} className="relative flex gap-3 py-1">
                    <span
                      className={`z-10 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-border bg-surface text-[11px] ${e.color}`}
                    >
                      {e.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{e.message}</div>
                      {e.who ? (
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                          {e.avatarName ? (
                            <PersonAvatar name={e.avatarName} size={16} />
                          ) : null}
                          <span>
                            by {e.who}
                            {e.via ? ` · via ${e.via}` : ""}
                          </span>
                        </div>
                      ) : null}
                      <div className="text-[11px] text-faint">
                        {formatShortDate(e.at)} · {formatTime(e.at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* Right: meta */}
          <div className="space-y-3">
            <Meta label="Status">
              <StatusSelect
                status={node.status}
                onChange={(s) => setStatus(taskId, s)}
                disabled={done}
              />
              {done ? (
                <p className="mt-1.5 text-[11px] text-faint">Reopen to change status.</p>
              ) : null}
            </Meta>
            <Meta label="Importance">
              <select
                value={task.importance ?? 0}
                onChange={(e) =>
                  editTask(taskId, { importance: Number(e.target.value) as Importance })
                }
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none"
              >
                {IMPORTANCE_ORDER.map((v) => (
                  <option key={v} value={v}>
                    {IMPORTANCE_LABEL[v]}
                  </option>
                ))}
              </select>
            </Meta>
            {task.value != null || task.difficulty != null ? (
              <Meta label="Points">
                <span className="flex flex-wrap items-center gap-1.5">
                  {task.value != null ? (
                    <PointsChip kind="value" points={task.value} withLabel />
                  ) : null}
                  {task.difficulty != null ? (
                    <PointsChip kind="difficulty" points={task.difficulty} withLabel />
                  ) : null}
                  {task.value != null && task.difficulty != null ? (
                    <span className="text-xs text-faint">
                      · challenge {task.value * task.difficulty}
                    </span>
                  ) : null}
                </span>
              </Meta>
            ) : null}
            <Meta label={(task.assigneeIds?.length ?? 0) > 1 ? "Assignees" : "Assignee"}>
              <AssigneeEditor
                taskId={taskId}
                assigneeIds={task.assigneeIds ?? []}
                onChange={editTask}
                memberIds={taskProject?.members}
                onEditMembers={
                  taskProject
                    ? () => openProjectSettings(taskProject.id)
                    : undefined
                }
              />
            </Meta>
            {task.startDate ? (
              <Meta label="Start">
                <span>{formatShortDate(task.startDate)}</span>
              </Meta>
            ) : null}
            {due ? (
              <Meta label="Due">
                <span
                  className={
                    done
                      ? "text-faint"
                      : due.overdue
                        ? "font-medium text-nerf"
                        : due.today
                          ? "font-medium text-accent"
                          : "text-fg"
                  }
                >
                  {due.label}
                </span>
              </Meta>
            ) : null}
            {task.recurrence && task.recurrence !== "none" ? (
              <Meta label="Repeats">
                <span>↻ {RECURRENCE_LABEL[task.recurrence]}</span>
              </Meta>
            ) : null}
            {task.dependsOn?.length ? (
              <Meta label="Blocked by">
                <ul className="space-y-1">
                  {task.dependsOn.map((depId) => (
                    <li key={depId}>
                      <button
                        onClick={() => openTask(depId)}
                        className="truncate text-left text-accent hover:underline disabled:text-faint disabled:no-underline"
                        disabled={!taskMap[depId]}
                      >
                        ⛔ {taskMap[depId]?.title ?? depId}
                      </button>
                    </li>
                  ))}
                </ul>
              </Meta>
            ) : null}
          </div>
        </div>
      </div>
    </div>

    {/* Lightbox — full-size viewer with ←/→ navigation across the images. */}
    {lightboxItem ? (
      <div
        className="fixed inset-0 flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-sm"
        style={{ zIndex: 100 + depth * 10 + 5 }}
        onClick={() => setLightboxOpen(false)}
      >
        <button
          type="button"
          onClick={() => setLightboxOpen(false)}
          className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
          aria-label="Close"
        >
          ✕
        </button>

        {attachments.length > 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedIndex((i) => (i - 1 + attachments.length) % attachments.length);
            }}
            className="absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-2xl text-white hover:bg-white/20"
            aria-label="Previous image"
          >
            ‹
          </button>
        ) : null}

        <figure
          className="flex max-h-full max-w-5xl flex-col items-center gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxItem.url}
            alt={lightboxItem.filename}
            className="max-h-[82vh] max-w-full rounded-lg object-contain shadow-2xl"
          />
          <figcaption className="text-xs text-slate-300">
            {lightboxItem.filename}
            {attachments.length > 1 ? ` · ${featuredIndex + 1} / ${attachments.length}` : ""}
          </figcaption>

          {/* Thumbnail strip — pick another image without leaving full screen. */}
          {attachments.length > 1 ? (
            <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
              {attachments.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedIndex(i)}
                  aria-current={i === featuredIndex}
                  className={`h-12 w-12 shrink-0 overflow-hidden rounded-md border transition ${
                    i === featuredIndex
                      ? "border-accent ring-1 ring-accent"
                      : "border-white/20 opacity-60 hover:opacity-100"
                  }`}
                  aria-label={`Show ${a.filename}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.filename} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </figure>

        {attachments.length > 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedIndex((i) => (i + 1) % attachments.length);
            }}
            className="absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-2xl text-white hover:bg-white/20"
            aria-label="Next image"
          >
            ›
          </button>
        ) : null}
      </div>
    ) : null}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
      {children}
    </div>
  );
}

/** A compact header copy button — shows a spinner while awaiting, then flashes
 *  "✓ Copied". Sized to match the other top-row header buttons. */
function CopyButton({
  label,
  title,
  busy,
  copied,
  onClick,
}: {
  label: string;
  title: string;
  busy: boolean;
  copied: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent-soft px-2 py-1 text-xs font-medium text-accent hover:bg-accent/15 disabled:opacity-70"
    >
      {busy ? (
        <span
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent"
          aria-hidden
        />
      ) : null}
      {copied ? "✓ Copied" : label}
    </button>
  );
}

/** Workflow block: revisable summaries + notes (incl. decisions) + commits.
 *  Notes are written by AIs only; the only edit here is checking off a note
 *  (resolving a transient one, e.g. a `review` item). */
function WorkflowSection({
  task,
  notes,
  commits,
}: {
  task: Task;
  notes: Note[];
  commits: TaskCommit[];
}) {
  const { resolveNote } = useWorkspace();
  const summaries: [string, string | null | undefined][] = [
    ["Analysis", task.analysisSummary],
    ["Technical Plan", task.plan],
    ["Summary", task.summary],
  ];
  const hasSummary = summaries.some(([, v]) => v);

  return (
    <div className="space-y-4">
      {hasSummary ? (
        <div className="space-y-2">
          {summaries.map(([label, val]) =>
            val ? (
              <div key={label}>
                <SectionLabel>{label}</SectionLabel>
                <div className="mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2">
                  <Markdown>{val}</Markdown>
                </div>
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      {/* Notes (decisions + standup callouts) — written by AIs only; hidden
          when there are none */}
      {notes.length ? (
        <div>
          <SectionLabel>Notes · {notes.length}</SectionLabel>
          <ul className="mt-1 space-y-1">
            {notes.map((n) => {
              const saving = n.id.startsWith("temp-");
              const isDecision = n.type === "decision";
              const isReview = n.type === "review";
              const resolved = Boolean(n.resolvedAt);
              return (
                <li
                  key={n.id}
                  className={`flex items-start gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm ${saving ? "opacity-60" : ""} ${resolved ? "opacity-50" : ""}`}
                >
                  {isReview && !saving ? (
                    <input
                      type="checkbox"
                      checked={resolved}
                      onChange={() => resolveNote(task.id, n.id, !resolved)}
                      className="mt-0.5 shrink-0 cursor-pointer accent-accent"
                      aria-label={resolved ? "Re-open review" : "Mark reviewed"}
                    />
                  ) : null}
                  <span className="min-w-0">
                    {n.type ? (
                      <span
                        className={`mr-1.5 rounded px-1 py-0.5 font-mono text-[10px] uppercase ${
                          isDecision
                            ? "bg-accent-soft text-accent"
                            : isReview
                              ? "bg-nerf-soft text-nerf"
                              : "bg-buff-soft text-buff"
                        }`}
                      >
                        {n.type}
                      </span>
                    ) : null}
                    <span className={resolved ? "text-fg line-through" : "text-fg"}>
                      {n.note}
                    </span>
                    {n.tags?.length ? (
                      <span className="text-faint">
                        {" "}
                        {n.tags.map((t) => `#${t}`).join(" ")}
                      </span>
                    ) : null}
                  </span>
                  {saving ? (
                    <span
                      className="ml-1.5 inline-block h-3 w-3 animate-spin rounded-full border border-faint border-t-transparent align-middle"
                      aria-label="Saving"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Commits */}
      {commits.length ? (
        <div>
          <SectionLabel>Commits · {commits.length}</SectionLabel>
          <ul className="mt-1 space-y-1">
            {commits.map((c) => (
              <li key={c.id} className="text-sm text-fg">
                <span className="font-mono text-xs text-accent">
                  {c.sha.slice(0, 8)}
                </span>{" "}
                {c.subject ?? ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-sm text-fg">{children}</div>
    </div>
  );
}
