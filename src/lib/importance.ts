import type { Importance } from "./types";

/** The importance ladder, most-important first. `0` (Normal) is the default;
 *  most tasks stay there. Negatives deprioritize (someday / not now). */
export const IMPORTANCE_ORDER: Importance[] = [3, 2, 1, 0, -1, -2];

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  3: "Critical",
  2: "High",
  1: "Elevated",
  0: "Normal",
  [-1]: "Low",
  [-2]: "Icebox",
};

/** Tone classes for the importance chip / picker (light theme). Normal is
 *  intentionally muted so a set importance is what draws the eye. */
export const IMPORTANCE_TONE: Record<
  Importance,
  { text: string; bg: string; border: string }
> = {
  3: { text: "text-nerf", bg: "bg-nerf-soft", border: "border-nerf/30" },
  2: { text: "text-nerf", bg: "bg-nerf-soft", border: "border-nerf/20" },
  1: { text: "text-accent", bg: "bg-accent-soft", border: "border-accent/25" },
  0: { text: "text-faint", bg: "bg-surface-2", border: "border-border" },
  [-1]: { text: "text-muted", bg: "bg-surface-2", border: "border-border" },
  [-2]: { text: "text-faint", bg: "bg-surface-2", border: "border-border" },
};

/** Is this a non-default importance worth surfacing as a chip/badge? */
export const isNotableImportance = (v: Importance | null | undefined): boolean =>
  v != null && v !== 0;
