"use client";

/**
 * Canvas index — one canvas per project (TD-136).
 *
 * Deliberately read-only. Creating and deleting used to live here, and both now
 * violate the 1:1 invariant from opposite ends: a project already gets its
 * canvas when it's created, and deleting one would leave that project with
 * nowhere for `placement` to resolve to, so every task filed to THIS WEEK or
 * BACKLOG would silently stay in INBOX. Renaming still happens on the canvas
 * itself.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import type { Canvas } from "@/lib/types";

export default function CanvasIndexPage() {
  const { projects } = useWorkspace();
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);

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

  const projectName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? "—";

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Canvas"
        subtitle="One whiteboard per project — its boards, laid out"
      />
      <div className="px-8 py-6">
        {canvases === null ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : canvases.length === 0 ? (
          <p className="text-sm text-faint">
            No canvases yet. Every project gets one when it&apos;s created.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {canvases.map((c) => (
              <Link
                key={c.id}
                href={`/canvas/${c.id}`}
                className="group relative block rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
              >
                <div className="grid h-24 place-items-center rounded-lg bg-surface-2 text-2xl text-faint">
                  ▦
                </div>
                <div className="mt-3 truncate text-sm font-medium text-fg">
                  {c.name}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-faint">
                  {projectName(c.projectId)}
                  {c.updatedAt
                    ? ` · updated ${new Date(c.updatedAt).toLocaleDateString()}`
                    : ""}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
