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

/** Tone classes for status pills / group headers (light theme). The process
 *  spine runs on a cool cyan→blue ramp: analyzing light cyan, analyzed a darker
 *  cyan, building blue — so a task visibly "cools" toward blue as it advances.
 *  `outline` is the canvas ring color (see STATUS_CANVAS_BADGE). */
export const STATUS_TONE: Record<
  TaskStatus,
  { text: string; bg: string; border: string; dot: string; icon: string; outline: string }
> = {
  backlog: {
    text: "text-slate-500",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-300",
    icon: "○",
    outline: "outline-slate-300",
  },
  todo: {
    text: "text-slate-600",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-400",
    icon: "◔",
    outline: "outline-slate-400",
  },
  analyzing: {
    text: "text-cyan-700",
    bg: "bg-cyan-50",
    border: "border-cyan-500/30",
    dot: "bg-cyan-500",
    icon: "◑",
    outline: "outline-cyan-500",
  },
  analyzed: {
    text: "text-cyan-800",
    bg: "bg-cyan-50",
    border: "border-cyan-700/30",
    dot: "bg-cyan-700",
    icon: "◕",
    outline: "outline-cyan-700",
  },
  building: {
    text: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-600/30",
    dot: "bg-blue-600",
    icon: "◐",
    outline: "outline-blue-600",
  },
  done: {
    text: "text-buff",
    bg: "bg-buff-soft",
    border: "border-buff/25",
    dot: "bg-buff",
    icon: "●",
    outline: "outline-buff",
  },
};

/** Statuses that get a ring + corner badge on the canvas, with their badge text.
 *  Presence here = "started work"; absent statuses (backlog/todo/done) get none.
 *  In-progress states carry an ellipsis; analyzed is a resting state, so plain. */
export const STATUS_CANVAS_BADGE: Partial<Record<TaskStatus, string>> = {
  analyzing: "Analyzing…",
  analyzed: "Analyzed",
  building: "Building…",
};

/** How often a task repeats — label + a compact glyph for chips. */
export const RECURRENCE_LABEL: Record<string, string> = {
  none: "Doesn’t repeat",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
