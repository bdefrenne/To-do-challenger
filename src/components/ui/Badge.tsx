import type { ReactNode } from "react";

type Tone = "neutral" | "green" | "red" | "amber" | "blue" | "purple";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted border-border",
  green: "bg-buff-soft text-buff border-buff/25",
  red: "bg-nerf-soft text-nerf border-nerf/25",
  amber: "bg-adjust-soft text-adjust border-adjust/25",
  blue: "bg-new-soft text-new border-new/25",
  purple: "bg-accent-soft text-accent border-accent/25",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * A small points chip for the value (payoff) and difficulty (effort) axes.
 * `kind` picks the glyph + tone so the two read differently at a glance.
 */
export function PointsChip({
  kind,
  points,
  withLabel = false,
}: {
  kind: "value" | "difficulty";
  points: number;
  withLabel?: boolean;
}) {
  const value = kind === "value";
  const label = value ? "Value" : "Difficulty";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
        value
          ? "border-buff/25 bg-buff-soft text-buff"
          : "border-adjust/25 bg-adjust-soft text-adjust"
      }`}
      title={`${label}: ${points}`}
    >
      <span aria-hidden>{value ? "★" : "◆"}</span>
      {withLabel ? <span>{label}</span> : null}
      <span className="nums">{points}</span>
    </span>
  );
}

/**
 * Small circular avatar. Presentational only — pass `imageUrl` for a profile
 * picture (else it shows initials) and `color` for the ring/stroke around it.
 * `ring` draws a thin surface-colored separator (used when avatars overlap).
 * Name→picture/color resolution lives in `AvatarStack` / `PersonAvatar`.
 */
export function Avatar({
  name,
  size = 22,
  imageUrl,
  color,
  ring = false,
}: {
  name: string;
  size?: number;
  imageUrl?: string | null;
  color?: string | null;
  ring?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  // Color ring = a surface gap then the person's color; box-shadow keeps it out
  // of the layout box so overlap math stays based on `size`.
  const boxShadow = color
    ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${color}`
    : ring
      ? "0 0 0 2px var(--color-surface)"
      : undefined;
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft font-semibold text-accent"
      style={{ width: size, height: size, fontSize: size * 0.42, boxShadow }}
      title={name}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}
