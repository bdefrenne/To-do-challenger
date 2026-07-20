import type { TaskStatus } from "./types";

/** Display order of status groups in the List (top → bottom): active first,
 *  down the process spine, Done last. */
export const STATUS_ORDER: TaskStatus[] = [
  "building",
  "analyzing",
  "analyzed",
  "todo",
  "backlog",
  "done",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  analyzing: "Analyzing",
  analyzed: "Analyzed",
  building: "Building",
  done: "Done",
};

/** Tone classes for status pills / group headers (light theme). */
export const STATUS_TONE: Record<
  TaskStatus,
  { text: string; bg: string; border: string; dot: string; icon: string }
> = {
  backlog: {
    text: "text-slate-500",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-300",
    icon: "○",
  },
  todo: {
    text: "text-slate-600",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-400",
    icon: "◔",
  },
  analyzing: {
    text: "text-accent",
    bg: "bg-accent-soft",
    border: "border-accent/25",
    dot: "bg-accent",
    icon: "◑",
  },
  analyzed: {
    text: "text-accent",
    bg: "bg-accent-soft",
    border: "border-accent/25",
    dot: "bg-accent",
    icon: "◕",
  },
  building: {
    text: "text-new",
    bg: "bg-new-soft",
    border: "border-new/25",
    dot: "bg-new",
    icon: "◐",
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
