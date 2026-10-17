import { useMemo } from "react";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useHiddenByCollections } from "@/contexts/collections-context";
import { useFilter } from "@/contexts/filter-context";
import { useHidden } from "@/contexts/hidden-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import { filterAndFlattenGallery, type GalleryItem } from "@/lib/filter";
import { getScopedBookmarks } from "@/lib/scope";

// Gallery-only counterpart of useFilteredBookmarks. Empty unless we're on the
// gallery tab so the flatten work doesn't run for other views. Scope
// partitioning lives in `getScopedBookmarks` (shared with the other filtered
// hooks) — see lib/scope.ts.
export function useFilteredGallery(): GalleryItem[] {
  const { bookmarks } = useBookmarks();
  const { state } = useFilter();
  const { hiddenIds } = useHidden();
  const { activeTab } = useTab();
  const { settings } = useSettings();
  const hiddenByCollections = useHiddenByCollections();

  return useMemo(() => {
    if (!bookmarks || activeTab !== "gallery") return [];
    // Gallery never shows archived items, so `archived` is always false here
    // — the activeTab !== "gallery" guard above already excluded the archive
    // tab from this hook.
    const scoped = getScopedBookmarks(
      bookmarks,
      hiddenIds,
      false,
      settings.hideUnfetched,
      null,
      hiddenByCollections,
    );
    return filterAndFlattenGallery(scoped, state);
  }, [bookmarks, state, hiddenIds, activeTab, settings.hideUnfetched, hiddenByCollections]);
}
