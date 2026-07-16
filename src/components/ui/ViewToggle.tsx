"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Remembers a view choice (e.g. List vs Boards) in localStorage, keyed per
 * page so it survives reloads and navigation. Uses useSyncExternalStore so
 * the server/hydration snapshot is the default (no mismatch) and the stored
 * value takes over on the client. Setting it also notifies other components
 * bound to the same key via a synthetic `storage` event.
 */
export function useViewMode<T extends string>(
  key: string,
  def: T,
): [T, (m: T) => void] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("storage", cb);
    return () => window.removeEventListener("storage", cb);
  }, []);
  const getSnapshot = useCallback((): T => {
    try {
      return (localStorage.getItem(key) as T | null) ?? def;
    } catch {
      return def;
    }
  }, [key, def]);
  const value = useSyncExternalStore(subscribe, getSnapshot, () => def);

  const set = useCallback(
    (m: T) => {
      try {
        localStorage.setItem(key, m);
      } catch {
        /* storage unavailable — this session only */
      }
      // Same-tab listeners don't get the native `storage` event; nudge them.
      window.dispatchEvent(new StorageEvent("storage", { key }));
    },
    [key],
  );
  return [value, set];
}

/** A small segmented control for switching between views. */
export function ViewToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={[
            "rounded-md px-3 py-1 font-medium transition-colors",
            value === o.value
              ? "bg-surface text-fg shadow-sm"
              : "text-faint hover:text-fg",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
