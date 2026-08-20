import { useEffect } from "react";
import { useEventCallback } from "./useEventCallback";

/**
 * Clears a drop zone's hover paint when the DRAG SESSION ends — however it ends.
 *
 * A zone that lights itself up in `onDragOver` can't reliably put itself out
 * again from its own handlers (TD2-201). Cards nested inside these zones stop
 * propagation on `drop`, deliberately, so a card drop isn't ALSO read as a
 * blank-area drop — which means the zone's own `onDrop` never runs. Nor can
 * `onDragLeave` save it: the card is a descendant, so the leave is (correctly)
 * ignored as a move within the zone. Once the drag is over no further event
 * fires on that element, and the outline stays lit forever.
 *
 * So the rule is: hover paint is cleared by the end of the drag, not by whoever
 * handled the drop. Two listeners, because neither closes it alone:
 *
 * - `drop` in CAPTURE phase — runs before any nested target's stopPropagation,
 *   so it sees every drop wherever it landed.
 * - `dragend` — covers Escape, a drop on nothing, and a drop outside the
 *   browser, where no `drop` fires at all. It can't stand in for the first:
 *   `dragend` targets the DRAG SOURCE, and a successful drop usually re-renders
 *   the dragged card into its new home, so the source may be unmounted before
 *   the event arrives (see the same hazard called out in `TaskTable`).
 *
 * Only ever clear PAINT here. Capture runs ahead of the real drop handlers, so
 * anything they still need to read (which board is being dragged, say) must not
 * be reset from this callback.
 *
 * Listens only while `active`, so a canvas full of sections costs nothing at rest.
 */
export function useDragSessionEnd(active: boolean, onEnd: () => void) {
  const end = useEventCallback(onEnd);
  useEffect(() => {
    if (!active) return;
    const clear = () => end();
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, [active, end]);
}
