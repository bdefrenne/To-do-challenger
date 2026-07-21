import type { Importance } from "./types";

/** The importance ladder, most-important first. `0` (Normal) is the default;
 *  most tasks stay there. Negatives deprioritize (someday / not now). */
export const IMPORTANCE_ORDER: Importance[] = [2, 1, 0, -1];

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  2: "High",
  1: "Elevated",
  0: "Normal",
  [-1]: "Low",
};

/** Tone classes for the importance chip / picker (light theme). Warm→cold:
 *  High red, Elevated orange, Normal muted (so a set importance draws the eye),
 *  Low cool grey. Kept in step with IMPORTANCE_CARD below. */
export const IMPORTANCE_TONE: Record<
  Importance,
  { text: string; bg: string; border: string }
> = {
  2: { text: "text-nerf", bg: "bg-nerf-soft", border: "border-nerf/30" },
  1: { text: "text-orange", bg: "bg-orange-soft", border: "border-orange/25" },
  0: { text: "text-faint", bg: "bg-surface-2", border: "border-border" },
  [-1]: { text: "text-muted", bg: "bg-surface-2", border: "border-border" },
};

/** Container tint (bg + border + hover) for a task card at this importance, on
 *  the same warm→cold ramp as IMPORTANCE_TONE. Normal (0) returns the neutral
 *  default so only a set importance stands out. `done` (green) overrides this. */
export const IMPORTANCE_CARD: Record<
  Importance,
  { bg: string; border: string; hover: string }
> = {
  2: { bg: "bg-nerf-soft", border: "border-nerf/40", hover: "hover:border-nerf/60" },
  1: { bg: "bg-orange-soft", border: "border-orange/40", hover: "hover:border-orange/60" },
  0: {
    bg: "bg-surface",
    border: "border-border",
    hover: "hover:border-border-strong hover:bg-surface-2",
  },
  [-1]: {
    bg: "bg-surface-2",
    border: "border-border-strong",
    hover: "hover:border-faint/50",
  },
};

/** Is this a non-default importance worth surfacing as a chip/badge? */
export const isNotableImportance = (v: Importance | null | undefined): boolean =>
  v != null && v !== 0;
