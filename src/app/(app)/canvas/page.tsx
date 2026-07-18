"use client";

/**
 * Canvas index — the list of standalone whiteboards. Create one, open it, or
 * delete it. Data is fetched directly (canvases aren't part of the task poll).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import type { Canvas } from "@/lib/types";

export default function CanvasIndexPage() {
  const router = useRouter();
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/canvases");
      if (alive && res.ok) setCanvases((await res.json()).canvases);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function create() {
    setCreating(true);
    const res = await fetch("/api/canvases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Untitled canvas" }),
    });
    setCreating(false);
    if (res.ok) {
      const { canvas } = await res.json();
      router.push(`/canvas/${canvas.id}`);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this canvas and everything on it?")) return;
    setCanvases((prev) => prev?.filter((c) => c.id !== id) ?? null);
    await fetch(`/api/canvases/${id}`, { method: "DELETE" });
  }

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Canvas"
        subtitle="Free-form whiteboards for brainstorming"
        right={
          <button
            onClick={create}
            disabled={creating}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "New canvas"}
          </button>
        }
      />
      <div className="px-8 py-6">
        {canvases === null ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : canvases.length === 0 ? (
          <p className="text-sm text-faint">
            No canvases yet. Create one to start brainstorming.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {canvases.map((c) => (
              <div
                key={c.id}
                className="group relative rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
              >
                <Link href={`/canvas/${c.id}`} className="block">
                  <div className="grid h-24 place-items-center rounded-lg bg-surface-2 text-2xl text-faint">
                    ▦
                  </div>
                  <div className="mt-3 truncate text-sm font-medium text-fg">
                    {c.name}
                  </div>
                  {c.updatedAt ? (
                    <div className="mt-0.5 text-[11px] text-faint">
                      Updated {new Date(c.updatedAt).toLocaleDateString()}
                    </div>
                  ) : null}
                </Link>
                <button
                  onClick={() => remove(c.id)}
                  title="Delete canvas"
                  className="absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-faint opacity-0 transition-opacity hover:text-nerf group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
