import { useActiveCollection } from "@/contexts/collections-context";
import { useActiveFolder } from "@/contexts/folders-context";

// The member set the active tab is scoped to: a collection's ids or an X
// folder's ids, or null on every other tab. Feeds `getScopedBookmarks`'s
// member-set argument; both kinds are explicit membership, so archived
// bookmarks still show in them.
export function useActiveMemberIds(): ReadonlySet<string> | null {
  const collection = useActiveCollection();
  const folder = useActiveFolder();
  return collection?.ids ?? folder?.ids ?? null;
}

// Name for the active collection or folder, for export titles; null on
// other tabs.
export function useActiveScopeName(): string | null {
  const collection = useActiveCollection();
  const folder = useActiveFolder();
  return collection?.name ?? folder?.name ?? null;
}
