/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useTab } from "@/contexts/tab-context";
import { folderIdOf } from "@/lib/tabs";

// An X bookmark folder, as ft mirrored it with `ft sync --folders`. Derived
// from the bookmarks' folder tags, so it's read-only here (ft can't write
// folders back to X) and a folder only exists locally while it has members:
// ft doesn't store the folder list itself, so an empty folder on X has no
// trace. A bookmark can sit in several folders.
export type XFolder = {
  id: string;
  name: string;
  ids: ReadonlySet<string>;
};

type FoldersContextValue = {
  // Sorted by name. X's own folder order isn't available locally.
  folders: XFolder[];
  byId: ReadonlyMap<string, XFolder>;
};

const FoldersContext = createContext<FoldersContextValue | null>(null);

export function FoldersProvider({ children }: { children: ReactNode }) {
  const { bookmarks } = useBookmarks();
  const { activeTab, setTab } = useTab();

  const value = useMemo<FoldersContextValue>(() => {
    const acc = new Map<string, { name: string; ids: Set<string> }>();
    for (const b of bookmarks ?? []) {
      for (const f of b.folders) {
        let entry = acc.get(f.id);
        if (!entry) {
          entry = { name: f.name, ids: new Set() };
          acc.set(f.id, entry);
        }
        entry.ids.add(b.id);
      }
    }
    const folders = [...acc.entries()]
      .map(([id, { name, ids }]) => ({ id, name, ids }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { folders, byId: new Map(folders.map((f) => [f.id, f])) };
  }, [bookmarks]);

  // A folder tab whose folder is gone (deleted or emptied on X, then synced)
  // falls back to Home, as a deleted collection's tab does. Only once
  // bookmarks have loaded, so a reload doesn't bounce off a folder tab.
  const activeFolderId = folderIdOf(activeTab);
  useEffect(() => {
    if (bookmarks && activeFolderId && !value.byId.has(activeFolderId)) {
      setTab("home");
    }
  }, [bookmarks, activeFolderId, value.byId, setTab]);

  return <FoldersContext.Provider value={value}>{children}</FoldersContext.Provider>;
}

export function useFolders(): FoldersContextValue {
  const ctx = useContext(FoldersContext);
  if (!ctx) throw new Error("useFolders must be used inside FoldersProvider");
  return ctx;
}

// The folder behind the active tab, or null when the tab isn't a folder.
export function useActiveFolder(): XFolder | null {
  const { byId } = useFolders();
  const { activeTab } = useTab();
  const id = folderIdOf(activeTab);
  return id ? (byId.get(id) ?? null) : null;
}
