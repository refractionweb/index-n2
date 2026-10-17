import { useMemo } from "react";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useActiveCollection } from "@/contexts/collections-context";
import { useFilter } from "@/contexts/filter-context";
import { useHidden } from "@/contexts/hidden-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import { filterBookmarks } from "@/lib/filter";
import { getScopedBookmarks } from "@/lib/scope";
import type { Bookmark } from "@/types/bookmark";

// Single source of truth for "what bookmarks does the active view show?".
// BookmarkGrid renders it, TopBar shows the count, App's Cmd+A handler selects
// it. Computing it in one place keeps those three in lockstep. Scope
// partitioning (archive tab + hideUnfetched) lives in `getScopedBookmarks`,
// shared with useFilteredGallery and useFilterCountSource — see lib/scope.ts.
export function useFilteredBookmarks(): Bookmark[] {
  const { bookmarks } = useBookmarks();
  const { state } = useFilter();
  const { hiddenIds } = useHidden();
  const { activeTab } = useTab();
  const { settings } = useSettings();
  const collectionIds = useActiveCollection()?.ids ?? null;

  return useMemo(() => {
    if (!bookmarks) return [];
    const scoped = getScopedBookmarks(
      bookmarks,
      hiddenIds,
      activeTab === "archive",
      settings.hideUnfetched,
      collectionIds,
    );
    return filterBookmarks(scoped, state);
  }, [bookmarks, state, hiddenIds, activeTab, settings.hideUnfetched, collectionIds]);
}
