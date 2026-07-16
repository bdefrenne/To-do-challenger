"use client";

/*
  Roster-aware avatars: resolve an assignee/author display-name against the
  people roster to show that user's profile picture + color ring. Falls back
  to plain initials for names with no matching account.
*/

import { Avatar } from "@/components/ui/Badge";
import { usePeople } from "@/components/PeopleContext";

/** A single avatar resolved from a display-name. */
export function PersonAvatar({
  name,
  size = 22,
  ring = false,
}: {
  name: string;
  size?: number;
  ring?: boolean;
}) {
  const { resolve, me } = usePeople();
  // "You" is the app's first-person authorship label (comments/activity) —
  // resolve it to the signed-in user so their own picture shows.
  const p = resolve(name) ?? (name === "You" ? me ?? undefined : undefined);
  return (
    <Avatar
      name={name}
      size={size}
      imageUrl={p?.avatarUrl ?? undefined}
      color={p?.color}
      ring={ring}
    />
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
  const { resolve } = usePeople();
  if (!names.length) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="flex items-center" title={names.join(", ")}>
      {shown.map((name, i) => {
        const p = resolve(name);
        return (
          <span key={`${name}-${i}`} style={{ marginLeft: i === 0 ? 0 : -size * 0.3 }}>
            <Avatar
              name={name}
              size={size}
              imageUrl={p?.avatarUrl ?? undefined}
              color={p?.color}
              ring
            />
          </span>
        );
      })}
      {extra > 0 ? (
        <span
          className="grid shrink-0 place-items-center rounded-full bg-surface-3 font-semibold text-muted"
          style={{
            width: size,
            height: size,
            fontSize: size * 0.38,
            marginLeft: -size * 0.3,
            boxShadow: "0 0 0 2px var(--color-surface)",
          }}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
