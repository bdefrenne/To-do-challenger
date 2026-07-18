"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/Badge";
import { AvatarCropper } from "@/components/ui/AvatarCropper";
import { SUMMARY_FILENAME } from "@/lib/repo-sync";

const DEFAULT_COLOR = "#7b68ee";
const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);

export interface EntityValues {
  name: string;
  /** Shortname / ref-prefix code. */
  code: string;
  color: string;
  gitFolder: string;
  /** Markdown readme. */
  description: string;
}

/**
 * Shared create/edit form for a project or board — both now carry the same
 * fields: name, shortname (`code`), color, picture, git folder, and a Markdown
 * readme (`description`). Reuses the profile-picture crop+upload flow; the
 * picture is uploaded *after* the row exists (its blob path needs the id), so
 * the cropped blob is handed back to `onSave` for the caller to upload.
 */
export function EntityFormModal({
  title,
  submitLabel,
  namePlaceholder,
  descriptionHint,
  initial,
  onSave,
  onClose,
  onDelete,
  deleteDisabled = false,
  deleteHint,
  extraSection,
}: {
  title: string;
  submitLabel: string;
  namePlaceholder: string;
  descriptionHint: string;
  initial: {
    name?: string;
    code?: string | null;
    color?: string;
    gitFolder?: string | null;
    description?: string | null;
    image?: string | null;
  };
  /** Persist the values (+ any cropped picture). Return true on success. */
  onSave: (
    values: EntityValues,
    picture: { blob: Blob | null; remove: boolean },
  ) => Promise<boolean>;
  onClose: () => void;
  /** Optional destructive action (edit mode). Renders a "Delete" button on the
   *  left of the footer; the handler owns confirmation + closing the modal. */
  onDelete?: () => void | Promise<void>;
  /** Block the delete button (e.g. the entity isn't empty yet). */
  deleteDisabled?: boolean;
  /** Faint explanation shown next to Delete when it's disabled. */
  deleteHint?: string;
  /** Extra content rendered below the description (e.g. a project's member
   *  picker). The caller owns this state and reads it in its own `onSave`. */
  extraSection?: ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initial.name ?? "");
  const [code, setCode] = useState(initial.code ?? "");
  const [color, setColor] = useState(initial.color ?? DEFAULT_COLOR);
  const [gitFolder, setGitFolder] = useState(initial.gitFolder ?? "");
  const [description, setDescription] = useState(initial.description ?? "");

  const [cropFile, setCropFile] = useState<File | null>(null);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removePicture, setRemovePicture] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingBlob) return;
    const url = URL.createObjectURL(pendingBlob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot object-URL for the cropped blob; revoked on cleanup
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingBlob]);

  const shownImage = pendingBlob
    ? previewUrl
    : removePicture
      ? null
      : (initial.image ?? null);
  const hasPicture = !!shownImage;

  async function save() {
    if (!name.trim()) return;
    if (color && !isHex(color)) {
      setErr("Color must be a #rrggbb hex value");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const ok = await onSave(
        {
          name: name.trim(),
          code: code.trim(),
          color,
          gitFolder: gitFolder.trim(),
          description: description.trim(),
        },
        { blob: pendingBlob, remove: removePicture },
      );
      if (ok) onClose();
      else setErr("Could not save — please try again");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!onDelete) return;
    setBusy(true);
    setErr(null);
    try {
      // The handler owns confirmation + closing on success; if the user backs
      // out we just re-enable the form.
      await onDelete();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold">{title}</h2>

        <div className="flex gap-5">
          {/* Picture */}
          <div className="flex flex-col items-center gap-2">
            <Avatar name={name || "?"} size={72} imageUrl={shownImage} color={color} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-surface-2 disabled:opacity-50"
            >
              {hasPicture ? "Change" : "Upload"}
            </button>
            {hasPicture ? (
              <button
                type="button"
                onClick={() => {
                  setPendingBlob(null);
                  setRemovePicture(true);
                }}
                disabled={busy}
                className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            ) : null}
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
          <div className="min-w-0 flex-1 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Shortname{" "}
                <span className="text-faint">(task prefix, e.g. GH → GH-12)</span>
              </span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Auto from name"
                maxLength={8}
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm uppercase text-fg outline-none focus:border-accent"
              />
            </label>

            <div>
              <span className="mb-1 block text-xs font-medium text-muted">Color</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={isHex(color) ? color : DEFAULT_COLOR}
                  onChange={(e) => setColor(e.target.value)}
                  aria-label="Pick color"
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
          </div>
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Git folder{" "}
            <span className="text-faint">(where the code lives — AIs read this)</span>
          </span>
          <input
            value={gitFolder}
            onChange={(e) => setGitFolder(e.target.value)}
            placeholder="/path/to/repo"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Description{" "}
            <span className="text-faint">(Markdown — {descriptionHint})</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="What is this, what is it for, and any constraints…"
            className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-faint">
            🔗 Keep this in sync with{" "}
            <code className="font-mono text-muted">{SUMMARY_FILENAME}</code> in the
            git folder (reference it from CLAUDE.md). Edit one → update the other.
          </span>
        </label>

        {extraSection ? <div className="mt-3">{extraSection}</div> : null}

        {err ? <p className="mt-3 text-xs text-nerf">{err}</p> : null}

        <div className="mt-5 flex items-center justify-between gap-2">
          {onDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={remove}
                disabled={busy || deleteDisabled}
                title={deleteHint}
                className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Delete
              </button>
              {deleteDisabled && deleteHint ? (
                <span className="max-w-[16rem] text-[11px] leading-tight text-faint">
                  {deleteHint}
                </span>
              ) : null}
            </div>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy || !name.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </div>
      </div>

      {cropFile ? (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onDone={(blob) => {
            setCropFile(null);
            setRemovePicture(false);
            setPendingBlob(blob);
          }}
        />
      ) : null}
    </div>
  );
}
