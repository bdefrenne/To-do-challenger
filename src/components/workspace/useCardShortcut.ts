import { useEffect, useRef, type RefObject } from "react";

/**
 * Fire `onFire` when `key` is pressed while the pointer is over the nearest
 * `[data-card]` ancestor of `ref` — the hover-scoped "A"/"S" shortcuts on canvas
 * Section task cards. Details that matter:
 *
 *   • Hover is read from the card's live `:hover` at press time, so exactly one
 *     card responds (no React hover state to thread around).
 *   • Registered in the CAPTURE phase and calls `stopPropagation()`, so it beats
 *     the canvas editor's own single-key tool shortcuts (T/F/B/V), which listen
 *     in the bubble phase on window.
 *   • No-op while a text field is focused, so the key stays a literal character
 *     in an input/textarea (the assign filter, the outline editor, …).
 *
 * `onFire` is held in a ref so the listener is registered once, not on every
 * render (callers pass a fresh closure each time).
 */
export function useCardShortcut(
  ref: RefObject<HTMLElement | null>,
  key: string,
  onFire: () => void,
) {
  const fireRef = useRef(onFire);
  useEffect(() => void (fireRef.current = onFire));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return;
      // Ignore auto-repeat: each card shortcut is one discrete action, and it
      // stops a held key (e.g. SPACE mid-pan drifting over a card) from firing
      // repeatedly.
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (
        ae instanceof HTMLElement &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
      ) {
        return;
      }
      const card = ref.current?.closest("[data-card]");
      if (!card || !card.matches(":hover")) return;
      e.preventDefault();
      e.stopPropagation();
      fireRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, key]);
}
