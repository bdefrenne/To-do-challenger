import type { TaskStatus } from "./types";

/** Display order of status groups in the List (top → bottom). */
export const STATUS_ORDER: TaskStatus[] = [
  "in-progress",
  "planned",
  "backlog",
  "done",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "To Do",
  planned: "Planned",
  "in-progress": "In Progress",
  done: "Complete",
};

/** Tone classes for status pills / group headers (light theme). */
export const STATUS_TONE: Record<
  TaskStatus,
  { text: string; bg: string; border: string; dot: string; icon: string }
> = {
  backlog: {
    text: "text-slate-600",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-400",
    icon: "○",
  },
  planned: {
    text: "text-accent",
    bg: "bg-accent-soft",
    border: "border-accent/25",
    dot: "bg-accent",
    icon: "◔",
  },
  "in-progress": {
    text: "text-new",
    bg: "bg-new-soft",
    border: "border-new/25",
    dot: "bg-new",
    icon: "◑",
  },
  done: {
    text: "text-buff",
    bg: "bg-buff-soft",
    border: "border-buff/25",
    dot: "bg-buff",
    icon: "●",
  },
};

/** How often a task repeats — label + a compact glyph for chips. */
export const RECURRENCE_LABEL: Record<string, string> = {
  none: "Doesn’t repeat",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
