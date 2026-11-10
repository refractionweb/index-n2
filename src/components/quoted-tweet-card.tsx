import { MediaPlaceholder } from "@/components/media-placeholder";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useFilter } from "@/contexts/filter-context";
import { useLightbox } from "@/contexts/lightbox-context";
import { fmtShortDate, truncateForCard } from "@/lib/format";
import { normalizeSearchTerm } from "@/lib/highlight";
import { linkifyText } from "@/lib/linkify";
import type { QuotedTweet } from "@/types/bookmark";

// Truncation threshold for the bookmark-card preview. Mirrors the main
// bookmark text truncation in bookmark-card.tsx (which keeps its own copy
// since it's used for the outer text too — not worth extracting one constant).
const TEXT_LIMIT = 280;

// Outer-shell classes shared between the real card and the missing
// placeholder. Single source of truth so the "this slot is a quoted tweet"
// visual identity stays consistent — if you tweak padding, border, or
// radius for the real card, the placeholder follows.
const QUOTE_CARD_OUTER = "block w-full rounded-md border p-2 text-sm";

// Shared rendering for a quoted tweet. Used in two places:
//   1. BookmarkCard — inline below the bookmark's text (truncated)
//   2. LightboxCardPanel — inline below the bookmark's text in the panel
//      (full text, no truncation)
//
// Click semantics: if the quoted tweet is itself bookmarked locally, open
// that bookmark's lightbox (full panel with engagement etc). Otherwise open
// the quote-snapshot lightbox via openQuote(). stopPropagation is
// unconditional — required when nested inside BookmarkCard (whose own
// onClick opens the outer bookmark) and inert in the lightbox panel where
// nothing above listens for clicks.
//
// Media is rendered inline: 1 photo full-width with original aspect ratio,
// capped at max-h-48; 2-4 photos as an equal-width square row. cursor-zoom-in
// matches the main MediaThumb affordance; each thumbnail opens the lightbox at
// its own index (openMedia(m.url)) rather than always the first image.
export function QuotedTweetCard({
  quote,
  truncate = false,
}: {
  // null signals an orphan quote — bookmark was a quote-tweet but the
  // quoted tweet's data is missing (deleted, protected, or unsynced).
  // Renders the inert "This post is unavailable." placeholder. Layout
  // height for this case is wired in compute-bookmark-height.ts via
  // MISSING_QUOTE_HEIGHT — keep them in sync if outer padding/border
  // changes here.
  quote: QuotedTweet | null;
  // BookmarkCard passes true (space-constrained masonry tile); the lightbox
  // panel passes false (room for the full text).
  truncate?: boolean;
}) {
  const { byId } = useBookmarks();
  const { open: openLightbox, openQuote } = useLightbox();
  const { state: filterState } = useFilter();
  const search = normalizeSearchTerm(filterState.search);
  if (!quote) {
    return (
      <div
        aria-label="Quoted post unavailable"
        className={`${QUOTE_CARD_OUTER} bg-muted/40 text-muted-foreground select-none`}
      >
        This post is unavailable.
      </div>
    );
  }
  const matched = byId.get(quote.id);
  // Open this quote in the lightbox. `mediaUrl` selects the starting image
  // (null → first); a clicked thumbnail passes its own `m.url` so the lightbox
  // opens on that image rather than always the first. The url resolves in
  // `matched.media` too: the server builds quote and bookmark media from the
  // same tweet via one shared buildMedia, so indexOf finds it in either array.
  const openMedia = (mediaUrl: string | null = null) => {
    if (matched) openLightbox(matched, mediaUrl);
    else openQuote(quote, mediaUrl);
  };
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openMedia();
  };
  const text = quote.text || "";
  const displayText = truncate ? truncateForCard(text, TEXT_LIMIT).text : text;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`${QUOTE_CARD_OUTER} hover:bg-muted/40 text-left`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs">
        {quote.pfp ? (
          <img
            src={quote.pfp}
            alt=""
            className="size-4 shrink-0 rounded-full object-cover"
          />
        ) : (
          <MediaPlaceholder className="size-4 shrink-0 rounded-full" />
        )}
        <span className="truncate font-medium">{quote.authorName}</span>
        <span className="text-muted-foreground truncate">@{quote.authorHandle}</span>
        {quote.postedAt && (
          <>
            <span className="text-muted-foreground">·</span>
            {/*
              Date stays a real <a> so cmd-click → new tab and right-click →
              "Copy link" still work. stopPropagation prevents the parent
              button's onClick (in-app lightbox) from also firing.
            */}
            <a
              href={quote.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground shrink-0 tabular-nums hover:underline"
            >
              {fmtShortDate(quote.postedAt)}
            </a>
          </>
        )}
      </div>

      {displayText && (
        <p className="break-words whitespace-pre-wrap">{linkifyText(displayText, search)}</p>
      )}

      {quote.media.length > 0 &&
        (quote.media.length === 1 ? (
          (() => {
            const m = quote.media[0];
            const ar =
              m.width && m.height
                ? { aspectRatio: `${m.width} / ${m.height}` }
                : undefined;
            const src = m.thumb ?? m.url;
            if (!src) {
              return (
                <MediaPlaceholder
                  className="mt-1.5 max-h-48 w-full rounded"
                  style={ar}
                />
              );
            }
            return (
              <img
                src={src}
                alt=""
                loading="lazy"
                onClick={(e) => {
                  e.stopPropagation();
                  openMedia(m.url);
                }}
                className="bg-muted mt-1.5 max-h-48 w-full cursor-zoom-in rounded object-cover"
                style={ar}
              />
            );
          })()
        ) : (
          <div className="mt-1.5 flex gap-1">
            {quote.media.slice(0, 4).map((m, i) => {
              const src = m.thumb ?? m.url;
              if (!src) {
                return (
                  <MediaPlaceholder
                    key={i}
                    className="aspect-square min-w-0 flex-1 rounded"
                  />
                );
              }
              return (
                <img
                  key={i}
                  src={src}
                  alt=""
                  loading="lazy"
                  onClick={(e) => {
                    e.stopPropagation();
                    openMedia(m.url);
                  }}
                  className="bg-muted aspect-square min-w-0 flex-1 cursor-zoom-in rounded object-cover"
                />
              );
            })}
          </div>
        ))}
    </button>
  );
}
