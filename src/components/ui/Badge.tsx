import type { ReactNode } from "react";
import type { TagTone } from "@/lib/types";
import { tagById } from "@/lib/mock-data";

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

const TAG_CLASS: Record<TagTone, string> = {
  purple: "bg-tag-purple-soft text-tag-purple",
  blue: "bg-tag-blue-soft text-tag-blue",
  green: "bg-tag-green-soft text-tag-green",
  amber: "bg-tag-amber-soft text-tag-amber",
  pink: "bg-tag-pink-soft text-tag-pink",
  gray: "bg-tag-gray-soft text-tag-gray",
};

/** A rounded, colored tag label resolved from a tag id. */
export function TagChip({ id }: { id: string }) {
  const tag = tagById(id);
  if (!tag) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TAG_CLASS[tag.tone]}`}
    >
      {tag.label}
    </span>
  );
}

/** Small circular avatar showing a person's initials. */
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {initials}
    </span>
  );
}

/** Overlapping avatars for multiple assignees; collapses the overflow to "+N". */
export function AvatarStack({
  names,
  size = 22,
  max = 3,
}: {
  names: string[];
  size?: number;
  max?: number;
}) {
  if (!names.length) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="flex items-center" title={names.join(", ")}>
      {shown.map((name, i) => (
        <span
          key={`${name}-${i}`}
          className="rounded-full ring-2 ring-surface"
          style={{ marginLeft: i === 0 ? 0 : -size * 0.3 }}
        >
          <Avatar name={name} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="grid shrink-0 place-items-center rounded-full bg-surface-3 font-semibold text-muted ring-2 ring-surface"
          style={{
            width: size,
            height: size,
            fontSize: size * 0.38,
            marginLeft: -size * 0.3,
          }}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
