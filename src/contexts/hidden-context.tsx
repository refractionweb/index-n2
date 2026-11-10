/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useServerDocument } from "@/hooks/use-server-document";

type HiddenValue = {
  hiddenIds: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  archive: (ids: string[]) => void;
  restore: (ids: string[]) => void;
};

const HiddenContext = createContext<HiddenValue | null>(null);

const EMPTY: ReadonlySet<string> = new Set();

function parseArchive(json: unknown): ReadonlySet<string> {
  if (!Array.isArray(json)) throw new Error("expected string[]");
  return new Set(json.filter((x): x is string => typeof x === "string"));
}

function serializeArchive(ids: ReadonlySet<string>): string[] {
  return [...ids];
}

export function HiddenProvider({ children }: { children: ReactNode }) {
  // Load / save / failure handling: see useServerDocument.
  const { value: hiddenIds, mutate } = useServerDocument({
    url: "/api/archive",
    label: "archive",
    empty: EMPTY,
    parse: parseArchive,
    serialize: serializeArchive,
  });

  const archive = useCallback(
    (ids: string[]) =>
      mutate((current) => {
        const next = new Set(current);
        for (const id of ids) next.add(id);
        return next;
      }),
    [mutate],
  );

  const restore = useCallback(
    (ids: string[]) =>
      mutate((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      }),
    [mutate],
  );

  const isHidden = useCallback(
    (id: string) => hiddenIds.has(id),
    [hiddenIds],
  );

  const value = useMemo<HiddenValue>(
    () => ({ hiddenIds, isHidden, archive, restore }),
    [hiddenIds, isHidden, archive, restore],
  );

  return (
    <HiddenContext.Provider value={value}>{children}</HiddenContext.Provider>
  );
}

export function useHidden(): HiddenValue {
  const ctx = useContext(HiddenContext);
  if (!ctx) throw new Error("useHidden requires <HiddenProvider>");
  return ctx;
}
