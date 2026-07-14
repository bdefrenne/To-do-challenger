import type { ReactNode } from "react";
import type { Priority, TagTone } from "@/lib/types";
import { tagById } from "@/lib/mock-data";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "@/lib/statuses";

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

/** ClickUp-style priority flag: a colored ⚑ with an optional label. */
export function PriorityFlag({
  priority,
  withLabel = false,
}: {
  priority: Priority;
  withLabel?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${PRIORITY_COLOR[priority]}`}
      title={`${PRIORITY_LABEL[priority]} priority`}
    >
      <span aria-hidden>⚑</span>
      {withLabel ? <span className="font-medium">{PRIORITY_LABEL[priority]}</span> : null}
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
