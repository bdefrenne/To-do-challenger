"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "./WorkspaceContext";
import type { PlacementMap, PlacementTitles } from "@/lib/sections";

/**
 * One project's canvas, flattened to `sectionId → placement` (plus each
 * bucket's name as it reads on the canvas) — see /api/placements.
 *
 * Held at the PAGE rather than inside the Boards view (TD2-218), because two
 * things now need the same answer: the bands the Boards view draws, and the
 * header's "Clear Done", which has to know which cards are already in the tray
 * and is on screen in every view. Fetching it twice would be two sources for one
 * question, and the header's copy could disagree with the columns'.
 *
 * Scoped to the project: canvases are per-project (TD-136), so an unscoped map
 * would bucket another project's sections into this project's bands. It is also
 * lent to the workspace (`registerPlacementMap`), which resolves a card's bucket
 * from its pin alone — that covers every machine-made lane, and this adds the
 * hand-made sections sitting inside a group, so what DELETE does to a card
 * matches the band it's rendered in.
 *
 * An empty map is a working default, not a failure: every machine-made lane id
 * NAMES its bucket (`placementOfDerivedId`), so everything simply reads as its
 * derived bucket, or INBOX, rather than vanishing.
 */
export function useProjectPlacements(projectId: string): {
  placements: PlacementMap;
  titles: PlacementTitles;
} {
  const { registerPlacementMap } = useWorkspace();
  const [placements, setPlacements] = useState<PlacementMap>({});
  const [titles, setTitles] = useState<PlacementTitles>({});

  useEffect(() => {
    let alive = true;
    fetch(`/api/placements?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { placements?: PlacementMap; titles?: PlacementTitles }) => {
        if (!alive) return;
        setPlacements(d.placements ?? {});
        setTitles(d.titles ?? {});
        registerPlacementMap(d.placements ?? {});
      })
      .catch(() => {
        /* leave both empty — see the note above */
      });
    return () => {
      alive = false;
    };
  }, [registerPlacementMap, projectId]);

  return { placements, titles };
}
