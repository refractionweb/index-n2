import { memo, type ReactNode } from "react";
import {
  RiBookmarkLine,
  RiChat3Line,
  RiHeart3Line,
  RiMoreFill,
  RiRepeatLine,
} from "@remixicon/react";
import type { Bookmark, MediaItem } from "@/types/bookmark";
import { expandTcoLinks, fmtAbsoluteDate, fmtNum } from "@/lib/format";
import { normalizeSearchTerm } from "@/lib/highlight";
import { linkifyText } from "@/lib/linkify";
import { extractReplyHandles } from "@/lib/reply-handles";
import { ArticleBlock, ArticleBlockPending } from "@/components/article-block";
import { AuthorLink } from "@/components/author-link";
import { BookmarkMenuItems } from "@/components/bookmark-menu-items";
import { CardVideo } from "@/components/card-video";
import { MediaPlaceholder } from "@/components/media-placeholder";
import { QuotedTweetCard } from "@/components/quoted-tweet-card";
import { ReplyOrThreadPills } from "@/components/reply-pills";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFilter } from "@/contexts/filter-context";
import { useHidden } from "@/contexts/hidden-context";
import { useLightbox } from "@/contexts/lightbox-context";
import { useSelection } from "@/contexts/selection-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import { cn } from "@/lib/utils";

const TEXT_LIMIT = 280;

// Memoized: BookmarkList re-renders on every scroll frame (setScrollY) and
// on settle/viewport transitions; with stable props an unchanged card skips
// its whole render — the text pipeline (expandTcoLinks / extractReplyHandles
// / linkifyText) and date formatting included. Same rationale as
// GalleryCard's memo. Selection, search, and lightbox state arrive via
// contexts, which re-render their subscribers regardless of memo.
export const BookmarkCard = memo(function BookmarkCard({
  bookmark,
  dimmedMediaUrls,
  scrollSettled = true,
  isInViewport = false,
}: {
  bookmark: Bookmark;
  dimmedMediaUrls?: ReadonlySet<string>;
  // Scroll-aware video mounting; both flags feed CardVideo. Defaults keep
  // the mount-immediately behavior for non-virtualized callers
  // (duplicates view).
  scrollSettled?: boolean;
  isInViewport?: boolean;
}) {
  const {
    id,
    authorHandle,
    authorName,
    pfp,
    postedAt,
    url,
    links,
    text,
    media,
    isThread,
    quotedTweet,
    quotedStatusId,
    engagement,
    article,
  } = bookmark;
  const { open: openLightbox } = useLightbox();
  const { isSelected, toggle } = useSelection();
  const { isHidden } = useHidden();
  const { activeTab } = useTab();
  const { state: filterState } = useFilter();
  const search = normalizeSearchTerm(filterState.search);
  const selected = isSelected(id);

  const expandedText = expandTcoLinks(text || "", links);
  const { handles, rest } = extractReplyHandles(expandedText);
  const truncated = rest.length > TEXT_LIMIT;
  const displayText = truncated ? rest.slice(0, TEXT_LIMIT) + "…" : rest;

  const handleCardClick = (e: React.MouseEvent) => {
    // Skip when the click landed on an interactive descendant (buttons, links,
    // media with its own handler, checkboxes).
    // [data-card-video] is CardVideo's poster stand-in during scroll — treated
    // like the <video> it replaces so click behavior doesn't change mid-scroll.
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'a, button, video, [data-card-video], [role="button"], [role="checkbox"], [data-slot="dropdown-menu-trigger"]'
      )
    ) {
      return;
    }
    openLightbox(bookmark);
  };

  return (
    <article
      className={cn(
        // Named group so the card's hover state doesn't collide with the
        // unnamed `group` inside AuthorLink (plain `group-hover:` would match
        // either ancestor, causing a card-wide hover to underline the author
        // name).
        "group/card bg-card cursor-pointer rounded-md ring-1 ring-border",
        selected && "ring-primary ring-2"
      )}
      onClick={handleCardClick}
    >
      <div className="flex flex-col gap-3 p-3">
        <header className="flex items-start gap-2">
          <AuthorLink
            handle={authorHandle}
            name={authorName}
            pfp={pfp}
            size="sm"
            highlight={search}
          />
          {activeTab !== "duplicates" && (
            <Checkbox
              className={cn(
                "mt-1 ml-auto shrink-0 transition-opacity",
                selected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100"
              )}
              aria-label={`Select bookmark from @${authorHandle}`}
              checked={selected}
              onCheckedChange={() => toggle(id)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </header>

        <ReplyOrThreadPills
          handles={handles}
          isThread={isThread}
          isArchived={isHidden(id) && activeTab === "duplicates"}
          url={url}
        />

        {/* For X Articles, the tweet text is just the t.co linking to the
            article. Three states:
              - article enriched     → ArticleBlock (title + body excerpt)
              - X Article URL only   → ArticleBlockPending (placeholder)
              - regular tweet        → tweet text as before
            Filter ⊃ render: TypeFilter `article` matches by URL pattern,
            so newly-bookmarked X Articles awaiting Backfill Gaps still
            pass the filter and need the placeholder render. */}
        {article ? (
          <ArticleBlock title={article.title} body={article.text} />
        ) : links.some((l) => l.includes("/i/article/")) ? (
          <ArticleBlockPending />
        ) : (
          displayText && (
            <div>
              <p className="text-sm break-words whitespace-pre-wrap">
                {linkifyText(displayText, search)}
              </p>
              {truncated && (
                <div className="text-primary mt-1 w-fit text-sm hover:underline">
                  Open full post
                </div>
              )}
            </div>
          )
        )}

        {media.length > 0 && (
          <CardMedia
            media={media}
            dimmedUrls={dimmedMediaUrls}
            scrollSettled={scrollSettled}
            isInViewport={isInViewport}
            onOpen={(m) => {
              openLightbox(bookmark, m.url);
            }}
          />
        )}

        {(quotedTweet || quotedStatusId) && (
          <QuotedTweetCard quote={quotedTweet ?? null} truncate />
        )}

        <div className="flex flex-col gap-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground self-start text-xs tabular-nums hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {fmtAbsoluteDate(postedAt)}
          </a>
          <footer className="text-muted-foreground flex items-center justify-between gap-2 text-xs tabular-nums">
            <EngagementStat icon={<RiChat3Line className="size-3.5" />} value={engagement.replyCount} />
            <EngagementStat icon={<RiRepeatLine className="size-3.5" />} value={engagement.repostCount} />
            <EngagementStat icon={<RiHeart3Line className="size-3.5" />} value={engagement.likeCount} />
            <EngagementStat
              icon={<RiBookmarkLine className="size-3.5" />}
              value={engagement.bookmarkCount}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="More actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <RiMoreFill />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onClick={(e) => e.stopPropagation()}
              >
                <BookmarkMenuItems bookmark={bookmark} />
              </DropdownMenuContent>
            </DropdownMenu>
          </footer>
        </div>
      </div>
    </article>
  );
});

function EngagementStat({ icon, value }: { icon: ReactNode; value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {fmtNum(value)}
    </span>
  );
}

function CardMedia({
  media,
  dimmedUrls,
  scrollSettled,
  isInViewport,
  onOpen,
}: {
  media: MediaItem[];
  dimmedUrls?: ReadonlySet<string>;
  scrollSettled: boolean;
  isInViewport: boolean;
  onOpen: (m: MediaItem) => void;
}) {
  const items = media.slice(0, 4);
  const n = items.length;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md",
        n >= 2 && "grid auto-rows-[180px] grid-cols-2 gap-0.5",
        n === 3 && "[&>*:first-child]:row-span-2",
      )}
    >
      {items.map((m, i) => (
        <MediaThumb
          key={i}
          media={m}
          solo={n === 1}
          dimmed={m.url ? (dimmedUrls?.has(m.url) ?? false) : false}
          scrollSettled={scrollSettled}
          isInViewport={isInViewport}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(m);
          }}
        />
      ))}
    </div>
  );
}

function MediaThumb({
  media,
  solo,
  dimmed,
  scrollSettled,
  isInViewport,
  onClick,
}: {
  media: MediaItem;
  solo: boolean;
  dimmed: boolean;
  scrollSettled: boolean;
  isInViewport: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const ar = media.width && media.height ? `${media.width} / ${media.height}` : undefined;
  const src = media.thumb ?? media.url;
  const { settings } = useSettings();
  const autoplay = settings.autoplayVideos;

  // Placeholder: source data has the media item but no file is on disk
  // yet (waiting for `ft fetch-media`). Show a gray block with a 1px
  // cross corner-to-corner. Non-interactive (no onClick — there's
  // nothing to lightbox into).
  if (!media.url && !media.thumb) {
    return (
      <MediaPlaceholder
        className={cn("h-full w-full", dimmed && "opacity-20")}
        style={solo ? (ar ? { aspectRatio: ar } : undefined) : { minHeight: 0 }}
      />
    );
  }

  // posterOnly: only the poster is on disk — falls through to the <img>.
  if (
    (media.type === "video" || media.type === "animated_gif") &&
    !media.posterOnly
  ) {
    // When autoplay is on: silent-loop preview with controls revealed on hover.
    // When off: paused at `poster` frame, controls always visible (touch devices
    // can't hover). Either way, the card's onClick guard excludes `video` (and
    // CardVideo's poster stand-in), so clicks here don't bubble to the
    // lightbox — users open the lightbox by clicking elsewhere on the card.
    return (
      <CardVideo
        url={media.url}
        poster={media.thumb}
        autoplay={autoplay}
        scrollSettled={scrollSettled}
        isInViewport={isInViewport}
        controls={!autoplay}
        hoverControls={autoplay}
        // box geometry only — CardVideo's layers apply object-cover inside
        className={cn("bg-muted h-full w-full", dimmed && "opacity-20")}
        style={solo ? (ar ? { aspectRatio: ar } : undefined) : { minHeight: 0 }}
      />
    );
  }
  return (
    <img
      src={src ?? undefined}
      loading="lazy"
      alt=""
      onClick={onClick}
      className={cn("bg-muted h-full w-full cursor-zoom-in object-cover", dimmed && "opacity-20")}
      style={solo ? (ar ? { aspectRatio: ar } : undefined) : { minHeight: 0 }}
    />
  );
}


