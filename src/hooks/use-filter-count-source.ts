import { useMemo } from "react";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useActiveCollection } from "@/contexts/collections-context";
import { useFilter, type FilterState } from "@/contexts/filter-context";
import { useHidden } from "@/contexts/hidden-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import {
  filterAndFlattenGallery,
  filterBookmarks,
  type GalleryItem,
} from "@/lib/filter";
import { getScopedBookmarks } from "@/lib/scope";
import type { Bookmark } from "@/types/bookmark";

export type FilterDimension =
  | "accounts"
  | "types"
  | "categories"
  | "languages"
  | "color"
  | "search";

// Source set for popover counts.
//
// Each popover shows "if I add an option from this dimension, how many would
// match." That requires applying every CURRENT filter except the dimension
// being counted, so its counts narrow as the user adds filters in OTHER
// dimensions but don't fight against the user's selection in THIS one.
//
// On Gallery, returns flattened GalleryItems so popover counts can be
// expressed in media units (1 bookmark with 3 photos contributes 3 to
// "image"). On Home/Archive, returns bookmarks.
export function useFilterCountSource(excludeDimension: FilterDimension): {
  bookmarks: Bookmark[];
  galleryItems: GalleryItem[];
  isGallery: boolean;
} {
  const { bookmarks } = useBookmarks();
  const { state } = useFilter();
  const { hiddenIds } = useHidden();
  const { activeTab } = useTab();
  const { settings } = useSettings();
  const collectionIds = useActiveCollection()?.ids ?? null;

  return useMemo(() => {
    const isGallery = activeTab === "gallery";
    if (!bookmarks) {
      return { bookmarks: [], galleryItems: [], isGallery };
    }

    // Scope partitioning shared with useFilteredBookmarks/useFilteredGallery
    // via lib/scope.ts. The previous hand-rolled copy here drifted on
    // hideUnfetched, leaking into popover counts ("1 hu" lie).
    const scoped = getScopedBookmarks(
      bookmarks,
      hiddenIds,
      activeTab === "archive",
      settings.hideUnfetched,
      collectionIds,
    );

    const partial = clearDimension(state, excludeDimension);

    if (isGallery) {
      return {
        bookmarks: [],
        galleryItems: filterAndFlattenGallery(scoped, partial),
        isGallery,
      };
    }
    return {
      bookmarks: filterBookmarks(scoped, partial),
      galleryItems: [],
      isGallery,
    };
  }, [bookmarks, state, hiddenIds, activeTab, excludeDimension, settings.hideUnfetched, collectionIds]);
}

function clearDimension(
  state: FilterState,
  dimension: FilterDimension,
): FilterState {
  switch (dimension) {
    case "accounts":
      return { ...state, accounts: new Set() };
    case "types":
      return { ...state, types: new Set() };
    case "categories":
      return { ...state, categories: new Set() };
    case "languages":
      return { ...state, languages: new Set() };
    case "color":
      return { ...state, color: null };
    case "search":
      return { ...state, search: "" };
  }
}
