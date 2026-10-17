// Tab identity + helpers. Fixed tabs are string literals; each user
// collection is a tab too, keyed `collection:<collectionId>`, so the grid,
// filters, selection bar and Cmd+A work in a collection unchanged.
export type TabId =
  | "home"
  | "gallery"
  | "archive"
  | "duplicates"
  | "settings"
  | `collection:${string}`;

const COLLECTION_PREFIX = "collection:";

export function collectionTab(collectionId: string): TabId {
  return `${COLLECTION_PREFIX}${collectionId}`;
}

// Collection id for a collection tab, null for every fixed tab.
export function collectionIdOf(tab: TabId): string | null {
  return tab.startsWith(COLLECTION_PREFIX)
    ? tab.slice(COLLECTION_PREFIX.length)
    : null;
}

// Tabs that render the bookmark/gallery grid with the full TopBar chrome.
// Duplicates and Settings are their own views.
export function isGridTab(tab: TabId): boolean {
  return (
    tab === "home" ||
    tab === "gallery" ||
    tab === "archive" ||
    collectionIdOf(tab) !== null
  );
}
