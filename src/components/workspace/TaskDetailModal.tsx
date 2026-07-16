"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Task,
  TaskLogEntry,
  TaskPhase,
  Decision,
  DecisionCategory,
  Note,
  NoteType,
  TaskCommit,
} from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { PointsChip, TagChip } from "@/components/ui/Badge";
import { AvatarStack, PersonAvatar } from "@/components/PersonAvatar";
import { usePeople } from "@/components/PeopleContext";
import { formatTime, formatShortDate, formatAge, formatDue } from "@/lib/format";
import { STATUS_LABEL, RECURRENCE_LABEL } from "@/lib/statuses";
import { StatusPill } from "./StatusPill";
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
    decisions,
    notes,
    commits,
    nodeById,
    start,
    toggleDone,
    setStatus,
    childrenOf,
    addComment,
    lockTask,
    recordDecision,
    addNote,
    addAttachment,
    removeAttachment,
    editTask,
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
        className="mt-12 w-full max-w-[940px] rounded-xl border border-border bg-surface shadow-2xl"
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
              {(task.tags ?? []).map((t) => (
                <TagChip key={t} id={t} />
              ))}
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

        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_240px]">
          {/* Left: details */}
          <div className="space-y-5">
            {/* actions */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={node.status} onChange={(s) => setStatus(taskId, s)} />
              {node.status !== "in-progress" && !done ? (
                <Button variant="primary" size="sm" onClick={() => start(taskId)}>
                  ▶ Start
                </Button>
              ) : null}
              <Button variant="success" size="sm" onClick={() => toggleDone(taskId)}>
                {done ? "↺ Reopen" : "✓ Mark done"}
              </Button>
            </div>

            {/* description */}
            {task.description ? (
              <div>
                <SectionLabel>Description</SectionLabel>
                <p className="mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
                  {task.description}
                </p>
              </div>
            ) : null}

            {/* workflow — summaries, decisions, notes, commits */}
            <WorkflowSection
              task={task}
              decisions={decisions[taskId] ?? []}
              notes={notes[taskId] ?? []}
              commits={commits[taskId] ?? []}
              onDecision={(input) => recordDecision(taskId, input)}
              onNote={(input) => addNote(taskId, input)}
            />

            {/* attachments */}
            <div>
              <div className="flex items-center justify-between">
                <SectionLabel>Attachments · {attachments.length}</SectionLabel>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-2 disabled:opacity-50"
                >
                  {uploading ? "Uploading…" : "+ Add image"}
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={onPickFiles}
              />
              {attachments.length === 0 ? (
                <p className="mt-1 text-xs text-faint">
                  Paste an image (⌘/Ctrl+V) or click “Add image”.
                </p>
              ) : featured ? (
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
              ) : null}
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

            {/* comments — the conversation thread (you ⇄ Claude) */}
            <div>
              <SectionLabel>Comments · {comments.length}</SectionLabel>
              <div className="mt-2 space-y-3">
                {comments.length === 0 ? (
                  <p className="text-xs text-faint">
                    No comments yet — start the conversation with your Claude.
                  </p>
                ) : (
                  comments.map((c) => {
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
                  })
                )}
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
            <Meta label="Status">
              <StatusPill status={node.status} onChange={(s) => setStatus(taskId, s)} />
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
            <Meta label={(task.assignees?.length ?? 0) > 1 ? "Assignees" : "Assignee"}>
              <AssigneeEditor taskId={taskId} assignees={task.assignees ?? []} onChange={editTask} />
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
  analyzing: "Analyzing",
  analyzed: "Analyzed",
  working: "Working",
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

const DECISION_CATEGORIES: DecisionCategory[] = [
  "business",
  "product",
  "ux",
  "technical",
  "scope",
];
const NOTE_TYPES: NoteType[] = ["progress", "blocker", "question", "fyi"];

/** Workflow block: revisable summaries + decisions + notes + commits. */
function WorkflowSection({
  task,
  decisions,
  notes,
  commits,
  onDecision,
  onNote,
}: {
  task: Task;
  decisions: Decision[];
  notes: Note[];
  commits: TaskCommit[];
  onDecision: (input: {
    category: DecisionCategory;
    decision: string;
    rationale?: string;
  }) => void;
  onNote: (input: { note: string; type?: NoteType }) => void;
}) {
  const [dCat, setDCat] = useState<DecisionCategory>("technical");
  const [dText, setDText] = useState("");
  const [nType, setNType] = useState<NoteType>("progress");
  const [nText, setNText] = useState("");

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

      {/* Decisions */}
      <div>
        <SectionLabel>Decisions · {decisions.length}</SectionLabel>
        <ul className="mt-1 space-y-1">
          {decisions.map((d) => {
            const saving = d.id.startsWith("temp-");
            return (
              <li
                key={d.id}
                className={`rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm ${saving ? "opacity-60" : ""}`}
              >
                <span className="mr-1.5 rounded bg-accent-soft px-1 py-0.5 font-mono text-[10px] uppercase text-accent">
                  {d.category}
                </span>
                <span className="text-fg">{d.decision}</span>
                {d.rationale ? (
                  <span className="text-faint"> — {d.rationale}</span>
                ) : null}
                {d.outcome ? (
                  <span className="ml-1.5 text-[11px] text-muted">({d.outcome})</span>
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
        <div className="mt-2 flex items-center gap-1.5">
          <select
            value={dCat}
            onChange={(e) => setDCat(e.target.value as DecisionCategory)}
            className="rounded-md border border-border bg-surface-2 px-1.5 py-1 text-xs text-fg"
          >
            {DECISION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            value={dText}
            onChange={(e) => setDText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dText.trim()) {
                onDecision({ category: dCat, decision: dText.trim() });
                setDText("");
              }
            }}
            placeholder="Record a decision…"
            className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Notes */}
      <div>
        <SectionLabel>Notes · {notes.length}</SectionLabel>
        <ul className="mt-1 space-y-1">
          {notes.map((n) => {
            const saving = n.id.startsWith("temp-");
            return (
              <li
                key={n.id}
                className={`rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm ${saving ? "opacity-60" : ""}`}
              >
                {n.type ? (
                  <span className="mr-1.5 rounded bg-buff-soft px-1 py-0.5 font-mono text-[10px] uppercase text-buff">
                    {n.type}
                  </span>
                ) : null}
                <span className="text-fg">{n.note}</span>
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
        <div className="mt-2 flex items-center gap-1.5">
          <select
            value={nType}
            onChange={(e) => setNType(e.target.value as NoteType)}
            className="rounded-md border border-border bg-surface-2 px-1.5 py-1 text-xs text-fg"
          >
            {NOTE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            value={nText}
            onChange={(e) => setNText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nText.trim()) {
                onNote({ note: nText.trim(), type: nType });
                setNText("");
              }
            }}
            placeholder="Add a standup note…"
            className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

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

/** Assign/unassign real users. Opens a dropdown of the roster; toggling a
 *  person persists the new assignee-name list via `editTask`. */
function AssigneeEditor({
  taskId,
  assignees,
  onChange,
}: {
  taskId: string;
  assignees: string[];
  onChange: (id: string, patch: { assignees: string[] }) => void;
}) {
  const { people } = usePeople();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const has = (name: string) => assignees.some((a) => a.toLowerCase() === name.toLowerCase());
  const toggle = (name: string) => {
    const next = has(name)
      ? assignees.filter((a) => a.toLowerCase() !== name.toLowerCase())
      : [...assignees, name];
    onChange(taskId, { assignees: next });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface"
      >
        {assignees.length ? (
          <>
            <AvatarStack names={assignees} size={20} />
            <span className="truncate text-fg">{assignees.join(", ")}</span>
          </>
        ) : (
          <span className="text-faint">Unassigned — click to assign</span>
        )}
        <span className="ml-auto text-faint">▾</span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
          {people.length === 0 ? (
            <p className="px-3 py-2 text-xs text-faint">No users yet.</p>
          ) : (
            people.map((p) => {
              const on = has(p.name);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.name)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  <PersonAvatar name={p.name} size={20} />
                  <span className="flex-1 truncate text-fg">{p.name}</span>
                  {on ? <span className="text-accent">✓</span> : null}
                </button>
              );
            })
          )}
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
