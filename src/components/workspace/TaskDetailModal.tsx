"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskLogEntry } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Avatar, AvatarStack, PointsChip, TagChip } from "@/components/ui/Badge";
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

/** Full task detail modal — opens on row click. Rendered once globally (in AppShell). */
export function TaskDetailModal() {
  const {
    openTaskId,
    openTask,
    closeTask,
    taskMap,
    logs,
    nodeById,
    start,
    toggleDone,
    setStatus,
    childrenOf,
    addComment,
    addAttachment,
    removeAttachment,
  } = useWorkspace();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState("");
  // Which attachment is featured (shown full-width in the panel, and full-size
  // in the lightbox). One index drives both, so selecting persists across open/close.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Clear the composer + reset the gallery when switching tasks (render-phase
  // state adjust — the recommended alternative to an effect).
  const [draftFor, setDraftFor] = useState(openTaskId);
  if (openTaskId !== draftFor) {
    setDraftFor(openTaskId);
    setDraft("");
    setSelectedIndex(0);
    setLightboxOpen(false);
  }

  // Keyboard: Escape closes the lightbox (if open) else the modal; when the
  // lightbox is open, ←/→ step the featured image (staying full screen).
  useEffect(() => {
    if (!openTaskId) return;
    const count = (taskMap[openTaskId]?.attachments ?? []).length;
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
  }, [openTaskId, closeTask, lightboxOpen, taskMap]);

  // Paste an image anywhere while the modal is open (Ctrl/⌘+V).
  useEffect(() => {
    if (!openTaskId) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            setUploading(true);
            addAttachment(openTaskId, file).finally(() => setUploading(false));
          }
          break;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [openTaskId, addAttachment]);

  if (!openTaskId) return null;
  const task = taskMap[openTaskId];
  const node = nodeById(openTaskId);
  if (!task || !node) return null;

  const allEntries = logs[openTaskId] ?? [];
  // Comments are their own conversation thread (oldest → newest, chat order);
  // everything else stays in the Activity timeline (newest first).
  const comments = allEntries
    .filter((e) => e.kind === "comment")
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const activity = allEntries
    .filter((e) => e.kind !== "comment")
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const kids = childrenOf(openTaskId);
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
    addComment(openTaskId, text);
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // allow re-picking the same file
    if (!files.length) return;
    setUploading(true);
    (async () => {
      for (const f of files) await addAttachment(openTaskId, f);
    })().finally(() => setUploading(false));
  };

  const lightboxItem = lightboxOpen ? featured : null;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-6 backdrop-blur-sm"
      onClick={closeTask}
    >
      <div
        className="mt-12 w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {(task.tags ?? []).map((t) => (
                <TagChip key={t} id={t} />
              ))}
            </div>
            <h2 className="text-lg font-semibold tracking-tight">{task.title}</h2>
          </div>
          <button
            onClick={closeTask}
            className="shrink-0 rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_240px]">
          {/* Left: details */}
          <div className="space-y-5">
            {/* actions */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={node.status} onChange={(s) => setStatus(openTaskId, s)} />
              {node.status !== "in-progress" && !done ? (
                <Button variant="primary" size="sm" onClick={() => start(openTaskId)}>
                  ▶ Start
                </Button>
              ) : null}
              <Button variant="success" size="sm" onClick={() => toggleDone(openTaskId)}>
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
                      onClick={() => removeAttachment(openTaskId, featured.id)}
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
            {kids.length > 0 ? (
              <div>
                <SectionLabel>Sub-tasks · {kids.length}</SectionLabel>
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
              </div>
            ) : null}

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
                        <Avatar name={author} size={24} />
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
              <StatusPill status={node.status} onChange={(s) => setStatus(openTaskId, s)} />
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
            {task.assignees?.length ? (
              <Meta label={task.assignees.length > 1 ? "Assignees" : "Assignee"}>
                <span className="flex items-center gap-2">
                  <AvatarStack names={task.assignees} size={20} />
                  <span className="truncate">{task.assignees.join(", ")}</span>
                </span>
              </Meta>
            ) : null}
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
        className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-sm"
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

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-sm text-fg">{children}</div>
    </div>
  );
}
