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

/** Overlapping avatars for multiple assignees (by account id); collapses the
 *  overflow to "+N". Unknown ids (e.g. a removed account) show a neutral "?". */
export function AvatarStack({
  ids,
  size = 22,
  max = 3,
}: {
  ids: string[];
  size?: number;
  max?: number;
}) {
  const { resolveById } = usePeople();
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  const extra = ids.length - shown.length;
  const label = ids.map((id) => resolveById(id)?.name ?? "?").join(", ");
  return (
    <span className="flex items-center" title={label}>
      {shown.map((id, i) => {
        const p = resolveById(id);
        return (
          <span key={`${id}-${i}`} style={{ marginLeft: i === 0 ? 0 : -size * 0.2 }}>
            <Avatar
              name={p?.name ?? "?"}
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
            marginLeft: -size * 0.2,
            boxShadow: "0 0 0 2px var(--color-surface)",
          }}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
