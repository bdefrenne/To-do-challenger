"use client";

import { SUMMARY_FILENAME, summaryPath } from "@/lib/repo-sync";
import { Markdown } from "@/components/ui/Markdown";

/**
 * Shows a project's / board's git folder and Markdown readme above its task
 * list. The readme is rendered as formatted Markdown for humans; AIs consume
 * the raw source over MCP.
 * Also surfaces the repo-sync convention: the description mirrors a file in the
 * git folder that must be kept in sync both ways. Renders nothing when both
 * git folder and description are empty.
 */
export function EntityReadme({
  gitFolder,
  description,
}: {
  gitFolder?: string | null;
  description?: string | null;
}) {
  if (!gitFolder && !description) return null;
  const filePath = gitFolder ? summaryPath(gitFolder) : SUMMARY_FILENAME;
  return (
    <div className="mb-6 rounded-xl border border-border bg-surface-2 px-4 py-3">
      {gitFolder ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="text-faint">Git folder</span>
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[12px] text-fg">
            {gitFolder}
          </code>
        </div>
      ) : null}
      {description ? <Markdown>{description}</Markdown> : null}
      <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-faint">
        🔗 Kept in sync with{" "}
        <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">
          {filePath}
        </code>{" "}
        in the repo (reference it from CLAUDE.md). Edit one → update the other.
      </p>
    </div>
  );
}
