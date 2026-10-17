import type { Bookmark } from "@/types/bookmark";

// Single source of truth for "what's in scope before per-filter logic runs."
// Three hooks (useFilteredBookmarks, useFilteredGallery, useFilterCountSource)
// previously inlined this same partitioning, and the count source's copy
// drifted — its "1 hu" lie when `hideUnfetched` was on came from one of the
// three pipelines forgetting the unfetched filter. Centralizing here makes
// the next scope-level setting (NSFW gate, date-range, etc.) a one-place
// change instead of a three-place coordination problem.
//
// `hideUnfetched`: a bookmark is dropped if any of its post-media OR quoted-
// tweet-media items has `url === null` (file not on disk). Pfp is exempt by
// design — `skipProfileImages` is a legitimate user choice and gating on a
// setting-driven absence would be wrong.
//
// Archive partitioning: the home tab shows non-hidden, the archive tab shows
// hidden. Gallery and other non-archive tabs follow the home rule. The
// boolean `archived` parameter is the discriminator — caller derives it from
// `activeTab === "archive"`.
//
// Collection partitioning: when `collectionIds` is given the scope is that
// member set, regardless of archive state — membership is explicit, so an
// archived bookmark still shows in a collection it was added to.
export function getScopedBookmarks(
  bookmarks: Bookmark[],
  hiddenIds: ReadonlySet<string>,
  archived: boolean,
  hideUnfetched: boolean,
  collectionIds: ReadonlySet<string> | null = null,
): Bookmark[] {
  let visible = collectionIds
    ? bookmarks.filter((b) => collectionIds.has(b.id))
    : archived
      ? bookmarks.filter((b) => hiddenIds.has(b.id))
      : bookmarks.filter((b) => !hiddenIds.has(b.id));
  if (hideUnfetched) {
    visible = visible.filter((b) => {
      if (b.media.some((m) => !m.url)) return false;
      if (b.quotedTweet?.media.some((m) => !m.url)) return false;
      return true;
    });
  }
  return visible;
}
