# To-do Challenger

A lightweight, **ClickUp-style task list** — light theme, grouped by status, with
drag-and-drop reordering/nesting, priority flags, tags, due dates, sub-tasks, an
inline "add task", a per-task detail modal with an activity log, and a **Today**
view for the tasks you've planned.

Built with **Next.js 16 (App Router)** · React 19 · TypeScript · Tailwind CSS v4.
All data is mock (no backend) — edit [`src/lib/mock-data.ts`](src/lib/mock-data.ts)
to change the sample content; swap that module for a real API later and the screens
keep working.

## Views

- **All tasks** (`/`) — the full list, grouped into In Progress · Planned · To Do ·
  Complete. Drag a row onto another to reorder, onto the middle to nest, or into a
  group header to change its status. Click any row to open its detail.
- **Today** (`/today`) — only your planned + in-progress tasks; unfinished ones
  carry over until done.

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Design tokens

The whole look lives in [`src/app/globals.css`](src/app/globals.css) (`@theme` block).
Components reference the tokens via Tailwind utilities (`bg-surface`, `text-muted`,
`text-accent`, status/priority/tag colors), so re-theming is a one-file change.
