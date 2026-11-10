export type MediaType = "photo" | "video" | "animated_gif";

export type LabColor = {
  L: number;
  a: number;
  b: number;
  w: number;
};

export type ColorData = {
  palette: LabColor[];
  avgL: number;
  avgChroma: number;
  darkPct: number;
  brightPct: number;
};

export type MediaItem = {
  type: MediaType;
  // null when the file isn't on disk yet (placeholder). The renderer
  // shows a gray-with-cross block in that case. Heights still compute
  // correctly because width/height are populated from the source data
  // even before download (they're metadata, not derived from the file).
  url: string | null;
  thumb: string | null;
  // null in the rare case where the source data doesn't include
  // dimensions; renderers fall back to a generic aspect ratio.
  width: number | null;
  height: number | null;
  colors: ColorData | null;
  // Video / GIF whose poster is on disk but no video file is (not
  // downloaded, or the source lists no variants — always the case for
  // quoted tweets). `url` is the poster image; render it as a still, never
  // as a <video> source. Absent on everything else.
  posterOnly?: boolean;
};

export type BookmarkFolder = {
  id: string;
  name: string;
};

export type Engagement = {
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
  bookmarkCount: number;
};

export type QuotedTweet = {
  // Tweet id from the source JSONL. If this matches a bookmark in `byId`, the
  // quoted card click opens that bookmark's lightbox instead of navigating to X.
  id: string;
  text: string;
  url: string;
  authorHandle: string;
  authorName: string;
  postedAt: string;
  pfp: string | null;
  // Media attached to the quoted tweet. Same shape as Bookmark.media —
  // ft fetch-media (1.3.13+) downloads quoted-tweet media into the same
  // media/ directory under ft's data dir, and the manifest tracks it. Empty when
  // the quoted tweet has no images/videos or when nothing has been fetched yet.
  media: MediaItem[];
};

export type Bookmark = {
  _order: number;
  id: string;
  url: string;
  text: string;
  authorHandle: string;
  authorName: string;
  pfp: string | null;
  postedAt: string;
  // Effectively always null. X's bookmarks GraphQL endpoint doesn't expose
  // when a bookmark was saved, and ft clears this field on every record it
  // syncs that way (sanitizeBookmarkedAt in ft's graphql-bookmarks.ts). The
  // saved order lives in the JSONL's line order instead (ft sorts by X's
  // sortIndex where both records have one, else by post time, then tweet
  // id; compareBookmarkChronology), which is what the saved-date sort uses.
  bookmarkedAt: string | null;
  // ISO timestamp from ft's last sync of this record. Used in the lightbox
  // Details panel to surface staleness ("Synced 2 days ago"). Not a save
  // date either.
  syncedAt: string | null;
  language: string;
  links: string[];
  engagement: Engagement;
  media: MediaItem[];
  // From ft classify (LLM or regex). `null` when unclassified. Filtering in
  // the GUI mirrors `ft list --category` — permissive, matches any entry in
  // `categories`, not just `primary_category`.
  primary_category: string | null;
  categories: string[];
  // X bookmark folders this bookmark is in, from `ft sync --folders`. Empty
  // when never tagged or untagged since. Read-only: ft can't write folders
  // back to X. Folder ids are stable across renames on X.
  folders: BookmarkFolder[];
  // X Article enrichment (`article_title` + `article_text` from
  // bookmarks.db). Populated only when the bookmark links to an X Article
  // (`x.com/i/article/<id>`); other ft-enriched URLs (YouTube, GitHub,
  // etc.) are filtered out at the server boundary so this field cleanly
  // means "render the X Article preview card." Null until ft enrichment
  // catches up to a freshly-bookmarked X Article.
  article: { title: string; text: string } | null;
  isThread: boolean;
  quotedTweet?: QuotedTweet;
  // Tweet id this bookmark quotes, when applicable. Set whenever the source
  // bookmark was a quote-tweet. Independent of `quotedTweet`: when the
  // quoted tweet's data is available, both this and `quotedTweet` are set;
  // when the quoted tweet wasn't captured at the original sync (Twitter
  // API didn't return the quote payload), `quotedStatusId` is set but
  // `quotedTweet` is undefined — an orphan. Orphans are recoverable via
  // `ft sync --gaps`, which retries the fetch; only originals that are
  // permanently gone (deleted, protected, suspended) stay orphans, and
  // ft marks those with `quotedTweetFailedAt` so subsequent --gaps runs
  // skip them rather than retrying forever. The GUI renders orphans as
  // a "This post is unavailable." placeholder card.
  quotedStatusId: string | null;
};
