// Tab identity + helpers. Fixed tabs are string literals; each user
// collection is a tab too, keyed `collection:<collectionId>`, and each X
// bookmark folder is keyed `folder:<folderId>`, so the grid, filters,
// selection bar and Cmd+A work in either unchanged.
export type TabId =
  | "home"
  | "gallery"
  | "archive"
  | "duplicates"
  | "settings"
  | `collection:${string}`
  | `folder:${string}`;

const COLLECTION_PREFIX = "collection:";
const FOLDER_PREFIX = "folder:";

export function collectionTab(collectionId: string): TabId {
  return `${COLLECTION_PREFIX}${collectionId}`;
}

// Collection id for a collection tab, null for every other tab.
export function collectionIdOf(tab: TabId): string | null {
  return tab.startsWith(COLLECTION_PREFIX)
    ? tab.slice(COLLECTION_PREFIX.length)
    : null;
}

export function folderTab(folderId: string): TabId {
  return `${FOLDER_PREFIX}${folderId}`;
}

// X folder id for a folder tab, null for every other tab.
export function folderIdOf(tab: TabId): string | null {
  return tab.startsWith(FOLDER_PREFIX) ? tab.slice(FOLDER_PREFIX.length) : null;
}

// Tabs that render the bookmark/gallery grid with the full TopBar chrome.
// Duplicates and Settings are their own views.
export function isGridTab(tab: TabId): boolean {
  return (
    tab === "home" ||
    tab === "gallery" ||
    tab === "archive" ||
    collectionIdOf(tab) !== null ||
    folderIdOf(tab) !== null
  );
}
