"use client";

/**
 * Shared Markdown renderer. The app authors task descriptions and project/board
 * readmes as Markdown; this renders them with the app's design tokens (there is
 * no Tailwind `prose`/typography plugin, so each element is styled explicitly).
 *
 * - `remark-gfm`   — GitHub-flavored markdown (inline code, lists, tables, links).
 * - `remark-breaks` — soft single newlines become <br>, so line breaks authored
 *   in the raw text are preserved on screen.
 *
 * `react-markdown` escapes raw HTML by default (no `dangerouslySetInnerHTML`), so
 * this is safe to point at user-authored content.
 *
 * SIZE AND TONE ARE PROPS, not classes a caller puts on a wrapper. The root below
 * sets its own `text-*` and `text-<color>`, and those beat anything inherited from
 * a parent — so `<div className="text-xs text-muted"><Markdown/></div>` silently
 * renders at the default size in the default color, which is a bug you can't see
 * while writing it. Pass `size` / `tone` instead.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

/** Body size. `xs` is for chrome — a card's description, a column head — where the
 *  markdown is supporting a thing rather than being the thing. */
const SIZE = {
  sm: "text-sm leading-relaxed",
  xs: "text-xs leading-snug",
} as const;

const TONE = { fg: "text-fg", muted: "text-muted" } as const;

export function Markdown({
  children,
  className = "",
  size = "sm",
  tone = "fg",
}: {
  children: string;
  className?: string;
  size?: keyof typeof SIZE;
  tone?: keyof typeof TONE;
}) {
  return (
    <div
      className={`${SIZE[size]} ${TONE[tone]} [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // Heading and code sizes are RELATIVE (`em`), so they follow `size`
        // instead of fighting it. At the default `sm` these are the pixel sizes
        // they always were.
        components={{
          h1: (p) => <h2 className="mb-1 mt-3 text-[1.15em] font-semibold" {...p} />,
          h2: (p) => <h3 className="mb-1 mt-3 text-[1em] font-semibold" {...p} />,
          h3: (p) => (
            <h4 className="mb-1 mt-2 text-[1em] font-semibold text-muted" {...p} />
          ),
          p: (p) => <p className="mb-2" {...p} />,
          ul: (p) => <ul className="mb-2 list-disc space-y-0.5 pl-5" {...p} />,
          ol: (p) => <ol className="mb-2 list-decimal space-y-0.5 pl-5" {...p} />,
          li: (p) => <li className="pl-0.5" {...p} />,
          a: (p) => (
            <a
              className="text-accent underline underline-offset-2 hover:opacity-80"
              target="_blank"
              rel="noopener noreferrer"
              {...p}
            />
          ),
          code: ({ className: cn, children: c, ...rest }) =>
            cn?.includes("language-") ? (
              // fenced code block — <pre> handles the box; keep the language class
              <code className={cn} {...rest}>
                {c}
              </code>
            ) : (
              <code
                className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em]"
                {...rest}
              >
                {c}
              </code>
            ),
          pre: (p) => (
            <pre
              className="mb-2 overflow-x-auto rounded-lg bg-surface-3 p-3 font-mono text-[0.9em]"
              {...p}
            />
          ),
          blockquote: (p) => (
            <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted" {...p} />
          ),
          strong: (p) => <strong className="font-semibold" {...p} />,
          hr: () => <hr className="my-3 border-border" />,
          table: (p) => (
            <div className="mb-2 overflow-x-auto">
              <table className="w-full border-collapse text-left" {...p} />
            </div>
          ),
          th: (p) => (
            <th className="border border-border px-2 py-1 font-semibold" {...p} />
          ),
          td: (p) => <td className="border border-border px-2 py-1" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
