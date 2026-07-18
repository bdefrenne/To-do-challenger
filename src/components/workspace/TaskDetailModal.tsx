"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Task,
  TaskLogEntry,
  TaskPhase,
  Note,
  TaskCommit,
} from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Markdown } from "@/components/ui/Markdown";
import { PointsChip } from "@/components/ui/Badge";
import { PersonAvatar } from "@/components/PersonAvatar";
import { formatTime, formatShortDate, formatAge, formatDue } from "@/lib/format";
import { STATUS_LABEL, RECURRENCE_LABEL } from "@/lib/statuses";
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
    lockTask,
    addAttachment,
    removeAttachment,
    editTask,
    projects,
    openProjectSettings,
  } = useWorkspace();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState("");
  // Which attachment is featured (shown full-width in the panel, and full-size
  // in the lightbox). One index drives both, so selecting persists across open/close.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [locking, setLocking] = useState(false);
  // Inline "add subtask" composer.
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [addingSub, setAddingSub] = useState(false);
  // Inline description editor: rendered Markdown by default, raw source on edit.
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descCopied, setDescCopied] = useState(false);

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
  const activity = allEntries
    .filter((e) => e.kind !== "comment")
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
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
  const saveDesc = () => {
    // Empty string clears it — the task PATCH schema takes a string, not null,
    // and `""` reads as falsy so the section falls back to "+ Add description".
    editTask(taskId, { description: descDraft.trim() });
    setEditingDesc(false);
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

  // Lock the code (if still soft) and copy the ready-to-paste work prompt.
  const copyPrompt = async () => {
    if (locking) return;
    setLocking(true);
    try {
      const prompt = await lockTask(taskId);
      await navigator.clipboard?.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[modal] copy prompt failed", e);
    } finally {
      setLocking(false);
    }
  };

  return (
    <>
    <div
      className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-6 backdrop-blur-sm"
      style={{ zIndex: 50 + depth * 10 }}
      onClick={closeTask}
    >
      <div
        className="mt-12 w-full max-w-[1090px] rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {task.code ? (
                <span
                  className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted"
                  title={task.refLocked ? "Locked code" : "Soft code — not locked yet"}
                >
                  {task.code}
                </span>
              ) : null}
              {task.phase ? <PhaseBadge phase={task.phase} /> : null}
            </div>
            <h2 className="text-lg font-semibold tracking-tight">{task.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={copyPrompt}
              disabled={locking}
              className="flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent-soft px-2 py-1 text-xs font-medium text-accent hover:bg-accent/15 disabled:opacity-70"
              title="Lock the code and copy a ready-to-paste prompt for your AI"
            >
              {locking ? (
                <span
                  className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent"
                  aria-hidden
                />
              ) : null}
              {copied ? "✓ Copied" : "⧉ Copy prompt"}
            </button>
            <button
              onClick={closeTask}
              className="rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_390px]">
          {/* Left: details */}
          <div className="space-y-5">
            {/* actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "+ Add image"}
              </Button>
            </div>
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
                {!editingDesc && task.description ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={copyDesc}
                      className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-2"
                    >
                      {descCopied ? "✓ Copied" : "⧉ Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={startEditDesc}
                      className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-2"
                    >
                      ✎ Edit
                    </button>
                  </div>
                ) : null}
              </div>
              {editingDesc ? (
                <div className="mt-1">
                  <textarea
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    autoFocus
                    rows={8}
                    placeholder="Describe this task…  (Markdown supported)"
                    className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none focus:border-accent"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="primary" size="sm" onClick={saveDesc}>
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingDesc(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : task.description ? (
                <div
                  onDoubleClick={startEditDesc}
                  title="Double-click to edit"
                  className="mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2"
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
                      className={`z-10 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-border bg-surface text-[11px] ${LOG_COLOR[e.kind]}`}
                    >
                      {LOG_ICON[e.kind]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{e.message}</div>
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
            {/* Big workflow CTAs — analyze / finish */}
            <div className="space-y-2">
              <Button
                variant={task.analyzedAt ? "success" : "outline"}
                onClick={() =>
                  editTask(taskId, {
                    analyzedAt: task.analyzedAt ? null : new Date().toISOString(),
                  })
                }
                className="w-full py-3 text-base"
              >
                {task.analyzedAt ? "✓ Analyzed" : "Mark analyzed"}
              </Button>
              <Button
                variant={done ? "success" : "primary"}
                onClick={() => toggleDone(taskId)}
                className="w-full py-3 text-base"
              >
                {done ? "✓ Finished" : "Mark finished"}
              </Button>
            </div>
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
            <Meta label="In status">
              <span className="nums">{formatAge(node.statusSince)}</span> in{" "}
              {STATUS_LABEL[node.status]}
            </Meta>
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
            {task.customFields && Object.keys(task.customFields).length > 0 ? (
              <Meta label="Custom fields">
                <dl className="space-y-1">
                  {Object.entries(task.customFields).map(([key, val]) => (
                    <div key={key} className="flex justify-between gap-2">
                      <dt className="text-faint">{key}</dt>
                      <dd className="truncate text-fg">{String(val)}</dd>
                    </div>
                  ))}
                </dl>
              </Meta>
            ) : null}

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
          </div>
        </div>
      </div>
    </div>

    {/* Lightbox — full-size viewer with ←/→ navigation across the images. */}
    {lightboxItem ? (
      <div
        className="fixed inset-0 flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-sm"
        style={{ zIndex: 50 + depth * 10 + 5 }}
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

const PHASE_LABEL: Record<TaskPhase, string> = {
  draft: "Draft",
  ready: "Ready",
  analyzed: "Analyzed",
  done: "Done",
};

/** Small badge for the derived workflow phase. */
export function PhaseBadge({ phase }: { phase: TaskPhase }) {
  return (
    <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
      {PHASE_LABEL[phase]}
    </span>
  );
}

/** Workflow block: revisable summaries + notes (incl. decisions) + commits.
 *  Notes are written by AIs only, so this is read-only. */
function WorkflowSection({
  task,
  notes,
  commits,
}: {
  task: Task;
  notes: Note[];
  commits: TaskCommit[];
}) {
  const summaries: [string, string | null | undefined][] = [
    ["Analysis", task.analysisSummary],
    ["Plan", task.plan],
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
                <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
                  {val}
                </p>
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
              return (
                <li
                  key={n.id}
                  className={`rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm ${saving ? "opacity-60" : ""}`}
                >
                  {n.type ? (
                    <span
                      className={`mr-1.5 rounded px-1 py-0.5 font-mono text-[10px] uppercase ${
                        isDecision
                          ? "bg-accent-soft text-accent"
                          : "bg-buff-soft text-buff"
                      }`}
                    >
                      {n.type}
                    </span>
                  ) : null}
                  <span className="text-fg">{n.note}</span>
                  {n.tags?.length ? (
                    <span className="text-faint">
                      {" "}
                      {n.tags.map((t) => `#${t}`).join(" ")}
                    </span>
                  ) : null}
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
