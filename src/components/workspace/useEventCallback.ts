import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback with a STABLE identity that always calls the latest version.
 *
 * For handing an event handler across a `memo` boundary. Most of this app's
 * handlers come off the workspace context, which rebuilds them every render, so
 * passing them straight down defeats any memo below — one task edit re-rendered
 * every card on the canvas (TD-132). Wrapping them here lets the boundary hold
 * without the card ever calling a stale closure.
 *
 * Only for functions the child CALLS (from an event handler or effect), never for
 * a value it renders from: the returned identity deliberately doesn't change, so
 * a child that reads through it during render would never re-render when the
 * underlying value did. Render-time inputs stay ordinary props.
 */
// The generic has to accept any handler shape, and its args are only ever
// forwarded — `any` here is the standard signature for this hook.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEventCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  // Layout effect, not render: a ref written during render breaks under
  // concurrent rendering (and `react-hooks/refs` forbids it). Committed before
  // any event can fire, which is the only time the wrapper below reads it.
  useLayoutEffect(() => {
    ref.current = fn;
  }, [fn]);
  const stable = useCallback((...args: Parameters<T>): ReturnType<T> => {
    return ref.current(...args);
  }, []);
  return stable as T;
}
