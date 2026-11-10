import { useCallback, useState } from "react";

// Persist the last `MAX_ENTRIES` queries (newest first), dedup
// case-sensitively, drop anything shorter than `MIN_LENGTH`. Stored as a JSON
// string array at `search-history`.
const STORAGE_KEY = "search-history";
const MAX_ENTRIES = 10;
const MIN_LENGTH = 2;

function load(): string[] {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function save(history: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // History is a convenience; survive quota/disabled storage silently.
  }
}

export type SearchHistory = {
  history: string[];
  push: (query: string) => void;
  remove: (query: string) => void;
  clear: () => void;
};

export function useSearchHistory(): SearchHistory {
  const [history, setHistory] = useState<string[]>(load);

  const push = useCallback((query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_LENGTH) return;
    setHistory((prev) => {
      const without = prev.filter((q) => q !== trimmed);
      const next = [trimmed, ...without].slice(0, MAX_ENTRIES);
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((query: string) => {
    setHistory((prev) => {
      const next = prev.filter((q) => q !== query);
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setHistory([]);
    save([]);
  }, []);

  return { history, push, remove, clear };
}
