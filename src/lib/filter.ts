import type { Bookmark, MediaItem } from "@/types/bookmark";
import type {
  FilterState,
  SortKey,
  SortOrder,
  TypeFilter,
} from "@/contexts/filter-context";
import { bookmarkMatchesColor, matchMediaColor } from "@/lib/color-match";
import { UNCLASSIFIED_CATEGORY } from "@/lib/categories";
import { matchesDateFilter, parseDateQuery } from "@/lib/date-filter";

export type GalleryItem = {
  bookmark: Bookmark;
  media: MediaItem;
};

export function matchesType(b: Bookmark, type: TypeFilter): boolean {
  switch (type) {
    case "text":
      return b.media.length === 0;
    case "image":
      return b.media.some((m) => m.type === "photo");
    case "video":
      return b.media.some((m) => m.type === "video");
    case "gif":
      return b.media.some((m) => m.type === "animated_gif");
    case "link":
      return b.links.length > 0;
    case "article":
      // X Articles — X's native long-form post format. URL pattern is
      // `x.com/i/article/<id>` (or twitter.com mirror); the `/i/article/`
      // segment is unique to this feature, so substring match suffices.
      // Distinct from external blog/news articles, which ride in `b.links`
      // as arbitrary URLs and aren't filterable as a clean class today.
      return b.links.some((l) => l.includes("/i/article/"));
    case "quoted":
      return !!b.quotedTweet;
    case "thread":
      return b.isThread;
  }
}

// Comparators sort *descending* by the given key — highest values first.
// "saved-date" desc means newest-saved first; "likes" desc means most-
// liked first. For ascending order, the caller reverses the result. This
// keeps the comparator table to one row per key (5 keys instead of 10
// key×direction combinations) and makes the symmetric direction toggle
// in the UI a one-line code path.
//
// `_order` is the line index in bookmarks.jsonl, which is written
// newest-first by ft sync, so lower _order = more recent.
//
// `postedAt` is in Twitter's legacy date format ("Sun May 03 12:19:31
// +0000 2026"), NOT ISO 8601. String comparison would sort by day-of-
// week letter first ("Fri" < "Mon" < "Sun"...) which is meaningless.
// Parse via Date and compare timestamps. Date.parse understands the
// Twitter format natively, so this works for both legacy and any future
// ISO-formatted postedAt without further branching.
function postedAtMs(b: Bookmark): number {
  if (!b.postedAt) return 0;
  const t = new Date(b.postedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const descSortFns: Record<
  Exclude<SortKey, "random">,
  (a: Bookmark, b: Bookmark) => number
> = {
  "saved-date": (a, b) => a._order - b._order,
  "posted-date": (a, b) => postedAtMs(b) - postedAtMs(a),
  likes: (a, b) => b.engagement.likeCount - a.engagement.likeCount,
  reposts: (a, b) => b.engagement.repostCount - a.engagement.repostCount,
  bookmarks: (a, b) => b.engagement.bookmarkCount - a.engagement.bookmarkCount,
};

// Pull tweet-id candidates out of a search query. Two extraction paths:
// (1) the trimmed query is a pure digit string — a pasted bare id; (2) the
// query contains `/status/<digits>` — the canonical id-bearing path on any
// X/Twitter URL variant (x.com, twitter.com, mobile, nitter, share-link
// forms). We don't gate on hostname because `/status/<digits>` is unique
// enough that false positives are negligible. Returns deduped candidates
// in priority order: bare-id first, URL-extracted second.
function extractIdCandidates(query: string): string[] {
  const out = new Set<string>();
  if (/^\d+$/.test(query)) out.add(query);
  const m = query.match(/\/status\/(\d+)/);
  if (m) out.add(m[1]);
  return [...out];
}

export function filterBookmarks(
  bookmarks: Bookmark[],
  state: FilterState
): Bookmark[] {
  const { accounts, types, color, search, categories: categoryFilter, languages, sort, order } = state;
  const hasAccounts = accounts.size > 0;
  const hasTypes = types.size > 0;
  const hasColor = !!color;
  const hasLanguages = languages.size > 0;
  const trimmed = search.trim();

  // Id-match shortcut. If the query is or contains a tweet id (raw digit
  // paste, or any X/Twitter URL with `/status/<id>`), and that id matches
  // a bookmark in scope — either as a bookmark id or via `quotedStatusId`
  // (a bookmark that quotes the searched id, including orphan-quote cases
  // where the quoted tweet's data is missing) — return that one bookmark
  // and bypass the rest of the filters. The bypass is intentional: pasting
  // a specific id signals "show me THIS one," and applying the active
  // account/type/color filters would silently hide a hit. Lookup priority
  // is bookmark-id first, quotedStatusId second — when an id is both, the
  // bookmarked copy wins. Maps are built lazily so the text-search path
  // pays no extra cost when no candidates are extracted.
  if (trimmed.length > 0) {
    const candidates = extractIdCandidates(trimmed);
    if (candidates.length > 0) {
      const byIdLocal = new Map<string, Bookmark>();
      for (const b of bookmarks) byIdLocal.set(b.id, b);
      for (const id of candidates) {
        const hit = byIdLocal.get(id);
        if (hit) return [hit];
      }
      const byQuoteIdLocal = new Map<string, Bookmark>();
      for (const b of bookmarks) {
        if (b.quotedStatusId && !byIdLocal.has(b.quotedStatusId)) {
          byQuoteIdLocal.set(b.quotedStatusId, b);
        }
      }
      for (const id of candidates) {
        const hit = byQuoteIdLocal.get(id);
        if (hit) return [hit];
      }
    }
  }

  const term = trimmed.toLowerCase().replace(/^@/, "");
  const hasTerm = term.length > 0;
  // The search term is dual-purpose. We try to parse it as a
  // date; if it parses, a bookmark passes when EITHER the text matches OR the
  // date matches (OR, not AND). Typing "april" includes both bookmarks
  // containing the word and bookmarks posted in any April. Parsed from the
  // raw query so "@jan" (a handle search) isn't read as January.
  const dateFilter = hasTerm ? parseDateQuery(trimmed) : null;
  const hasCategories = categoryFilter.size > 0;
  const wantsUnclassified = categoryFilter.has(UNCLASSIFIED_CATEGORY);

  const result: Bookmark[] = [];
  for (const b of bookmarks) {
    if (hasTerm) {
      const textHit =
        b.text.toLowerCase().includes(term) ||
        b.authorHandle.toLowerCase().includes(term) ||
        b.authorName.toLowerCase().includes(term) ||
        !!b.quotedTweet?.text.toLowerCase().includes(term) ||
        !!b.quotedTweet?.authorHandle.toLowerCase().includes(term) ||
        !!b.quotedTweet?.authorName.toLowerCase().includes(term);
      const dateHit = dateFilter !== null && matchesDateFilter(b, dateFilter);
      if (!textHit && !dateHit) continue;
    }
    if (hasColor && !bookmarkMatchesColor(b, color)) continue;
    if (hasTypes) {
      let match = false;
      for (const t of types) {
        if (matchesType(b, t)) {
          match = true;
          break;
        }
      }
      if (!match) continue;
    }
    if (hasAccounts && !accounts.has(b.authorHandle)) continue;
    if (hasLanguages && !languages.has(b.language)) continue;
    // Multi-select category filter. OR semantics across the selected set:
    // a bookmark passes if ANY of its own categories is in the filter set,
    // or if "Uncategorized" is selected and the bookmark has no categories
    // at all. Permissive within each bookmark's category list, mirroring
    // `ft list --category` (SQL: `categories LIKE '%X%'`).
    if (hasCategories) {
      let match = false;
      if (wantsUnclassified && b.categories.length === 0 && !b.primary_category) {
        match = true;
      }
      if (!match) {
        for (const c of b.categories) {
          if (categoryFilter.has(c)) {
            match = true;
            break;
          }
        }
      }
      if (!match) continue;
    }
    result.push(b);
  }

  applySort(result, sort, order);
  return result;
}

function applySort(result: Bookmark[], sort: SortKey, order: SortOrder) {
  if (sort === "random") {
    // Fisher-Yates, fresh every recompute.
    // Order is irrelevant for random and ignored.
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return;
  }
  result.sort(descSortFns[sort]);
  if (order === "asc") result.reverse();
}

// Gallery view: filter at bookmark level for everything *except* types and
// color (which apply per-image), then flatten each surviving bookmark's media
// items, applying type+color per image.
export function filterAndFlattenGallery(
  bookmarks: Bookmark[],
  state: FilterState
): GalleryItem[] {
  const { accounts, types, color, search, categories: categoryFilter, languages, sort, order } = state;
  const hasAccounts = accounts.size > 0;
  const hasLanguages = languages.size > 0;
  const trimmed = search.trim();
  const term = trimmed.toLowerCase().replace(/^@/, "");
  const hasTerm = term.length > 0;
  const dateFilter = hasTerm ? parseDateQuery(trimmed) : null;
  const hasCategories = categoryFilter.size > 0;
  const wantsUnclassified = categoryFilter.has(UNCLASSIFIED_CATEGORY);

  // Bookmark-level pass: search, accounts, categories. Skip types + color (per-image).
  const surviving: Bookmark[] = [];
  for (const b of bookmarks) {
    if (hasTerm) {
      const textHit =
        b.text.toLowerCase().includes(term) ||
        b.authorHandle.toLowerCase().includes(term) ||
        b.authorName.toLowerCase().includes(term) ||
        !!b.quotedTweet?.text.toLowerCase().includes(term) ||
        !!b.quotedTweet?.authorHandle.toLowerCase().includes(term) ||
        !!b.quotedTweet?.authorName.toLowerCase().includes(term);
      const dateHit = dateFilter !== null && matchesDateFilter(b, dateFilter);
      if (!textHit && !dateHit) continue;
    }
    if (hasAccounts && !accounts.has(b.authorHandle)) continue;
    if (hasLanguages && !languages.has(b.language)) continue;
    if (hasCategories) {
      let match = false;
      if (wantsUnclassified && b.categories.length === 0 && !b.primary_category) {
        match = true;
      }
      if (!match) {
        for (const c of b.categories) {
          if (categoryFilter.has(c)) {
            match = true;
            break;
          }
        }
      }
      if (!match) continue;
    }
    if (b.media.length === 0) continue;
    surviving.push(b);
  }

  applySort(surviving, sort, order);

  // Per-image pass: only image/video/gif type filters apply in gallery; the
  // text/link/quoted/thread filters are ignored (they're bookmark-level
  // concepts that don't map to individual media).
  const wantImage = types.has("image");
  const wantVideo = types.has("video");
  const wantGif = types.has("gif");
  const mediaTypeActive = wantImage || wantVideo || wantGif;
  const hasColor = !!color;

  const flat: GalleryItem[] = [];
  for (const b of surviving) {
    for (const m of b.media) {
      // Skip placeholder media (file not on disk yet). Gallery is a
      // dense visual browse — a tile with no actual image defeats the
      // purpose. BookmarkCard / Archive still show placeholders so
      // those layouts reserve the right slot, but Gallery only lists
      // items with a real file behind them.
      if (!m.url) continue;
      if (mediaTypeActive) {
        const isPhoto = m.type === "photo";
        const isVideo = m.type === "video";
        const isGif = m.type === "animated_gif";
        if (
          !((wantImage && isPhoto) ||
            (wantVideo && isVideo) ||
            (wantGif && isGif))
        )
          continue;
      }
      if (hasColor && !matchMediaColor(m.colors, color)) continue;
      flat.push({ bookmark: b, media: m });
    }
  }
  return flat;
}
