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
 *
 * ONE window listener serves every card, not one per (card × key). Each card
 * registers nine of these, so on a canvas with a couple of hundred cards the
 * naive version put ~2,000 capture-phase listeners on `window` — and every
 * keystroke ANYWHERE in the app (typing a title, filtering assignees) had to run
 * all of them, each calling `matches(":hover")`, which forces a style resolution.
 * The shared listener below resolves hover ONCE per keypress and then does map
 * lookups, which is what makes typing over a full canvas feel instant.
 */

/** One live registration: which element to resolve a card from, and what to
 *  fire. `fireRef` rather than a function so re-renders never re-register. */
interface Entry {
  ref: RefObject<HTMLElement | null>;
  fireRef: { current: () => void };
}

/** key (lower-case, as `useCardShortcut` receives it) → the cards listening.
 *  A key may carry a `shift+` prefix; see `onKey` for how it's resolved. */
const registry = new Map<string, Set<Entry>>();
/** Installed with the first entry, removed with the last — so a page carrying no
 *  cards (and SSR) never has a listener at all. */
let listening = false;

function onKey(e: KeyboardEvent) {
  // SHIFT is looked up FIRST and falls through, rather than being part of the key
  // outright: `shift+arrowup` (send to TODAY) must be distinguishable from
  // `arrowup` (send to THIS WEEK), but holding shift while pressing D or SPACE
  // has always fired those and silently must go on doing so. Meta/ctrl/alt stay
  // disqualifying below — those are browser and OS gestures, not ours.
  const bare = e.key.toLowerCase();
  const entries =
    (e.shiftKey ? registry.get(`shift+${bare}`) : undefined) ?? registry.get(bare);
  if (!entries?.size) return;
  // Ignore auto-repeat: each card shortcut is one discrete action, and it stops
  // a held key (e.g. SPACE mid-pan drifting over a card) from firing repeatedly.
  if (e.repeat) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement;
  if (
    ae instanceof HTMLElement &&
    (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
  ) {
    return;
  }
  // The one expensive step, paid once for the whole registry instead of once per
  // entry. Cards never nest inside each other (a subtask card is a SIBLING of
  // its parent's card, under a shared wrapper), so this is a set of at most one
  // — but it stays a set so a future nesting can't silently drop a card.
  const hovered = document.querySelectorAll("[data-card]:hover");
  if (!hovered.length) return;
  const hoveredCards = new Set<Element>(hovered);
  let fired = false;
  // Snapshot: a handler can unmount cards (DELETE), which would otherwise
  // mutate the set we're iterating.
  for (const entry of [...entries]) {
    const card = entry.ref.current?.closest("[data-card]");
    if (!card || !hoveredCards.has(card)) continue;
    fired = true;
    entry.fireRef.current();
  }
  if (!fired) return;
  e.preventDefault();
  e.stopPropagation();
}

function register(key: string, entry: Entry): () => void {
  let entries = registry.get(key);
  if (!entries) registry.set(key, (entries = new Set()));
  entries.add(entry);
  if (!listening) {
    listening = true;
    window.addEventListener("keydown", onKey, true);
  }
  return () => {
    entries.delete(entry);
    if (entries.size === 0) registry.delete(key);
    if (listening && registry.size === 0) {
      listening = false;
      window.removeEventListener("keydown", onKey, true);
    }
  };
}

export function useCardShortcut(
  ref: RefObject<HTMLElement | null>,
  key: string,
  onFire: () => void,
) {
  const fireRef = useRef(onFire);
  useEffect(() => void (fireRef.current = onFire));

  useEffect(() => register(key, { ref, fireRef }), [ref, key]);
}
