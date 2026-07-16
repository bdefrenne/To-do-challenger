"use client";

/*
  PEOPLE ROSTER — the real user accounts, so the UI can turn an assignee
  display-name into a picture + color, and the assignee picker can offer the
  actual people (not free-text). Fetched once from /api/users and refreshed on
  window focus (e.g. after someone edits their profile in another tab).
*/

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Person {
  id: string;
  email: string;
  name: string;
  color: string;
  avatarUrl: string | null;
}

interface PeopleContextValue {
  people: Person[];
  /** Resolve an assignee display-name to a person (case-insensitive). */
  resolve: (name: string) => Person | undefined;
  /** The signed-in user (kept fresh from the roster). */
  me: Person | null;
  refresh: () => void;
}

const EMPTY: PeopleContextValue = {
  people: [],
  resolve: () => undefined,
  me: null,
  refresh: () => {},
};

const PeopleContext = createContext<PeopleContextValue>(EMPTY);

export function PeopleProvider({
  me: initialMe,
  children,
}: {
  me: Person;
  children: ReactNode;
}) {
  // Seed with the server-resolved current user so avatars are correct on first
  // paint, before the roster fetch lands.
  const [people, setPeople] = useState<Person[]>([initialMe]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (res.ok) {
        const { users } = (await res.json()) as { users: Person[] };
        if (Array.isArray(users) && users.length) setPeople(users);
      }
    } catch {
      /* transient — a later focus/refresh retries */
    }
  }, []);

  useEffect(() => {
    // Initial load inline (setState is post-await, so no cascading render);
    // refresh() is reused for the focus handler.
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/users");
        if (!alive || !res.ok) return;
        const { users } = (await res.json()) as { users: Person[] };
        if (Array.isArray(users) && users.length) setPeople(users);
      } catch {
        /* transient — a later focus/refresh retries */
      }
    })();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const value = useMemo<PeopleContextValue>(() => {
    const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p]));
    return {
      people,
      resolve: (name: string) => byName.get(name.trim().toLowerCase()),
      me: people.find((p) => p.id === initialMe.id) ?? initialMe,
      refresh,
    };
  }, [people, initialMe, refresh]);

  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

export function usePeople(): PeopleContextValue {
  return useContext(PeopleContext);
}
