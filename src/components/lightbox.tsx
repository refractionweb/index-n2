import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiBookmarkLine,
  RiChat3Line,
  RiChatQuoteLine,
  RiCloseLine,
  RiFilter3Line,
  RiFileCopyLine,
  RiHeart3Line,
  RiMoreFill,
  RiRepeatLine,
} from "@remixicon/react";
import { BookmarkMenuItems } from "@/components/bookmark-menu-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useIsMobile } from "@/hooks/use-mobile";
import { useHidden } from "@/contexts/hidden-context";
import { useTab } from "@/contexts/tab-context";
import { useLightbox } from "@/contexts/lightbox-context";
import { useFilter } from "@/contexts/filter-context";
import { ArticleBlockPending } from "@/components/article-block";
import { AuthorLink } from "@/components/author-link";
import { MediaPlaceholder } from "@/components/media-placeholder";
import { QuotedTweetCard } from "@/components/quoted-tweet-card";
import { ReplyOrThreadPills } from "@/components/reply-pills";
import { useCopyFeedback } from "@/lib/clipboard";
import { hexToRgb, rgbToHsv } from "@/lib/color-space";
import { labToHex, labToRgb } from "@/lib/color-math";
import {
  expandTcoLinks,
  fmtAbsoluteDate,
  fmtNum,
  fmtRelativeDate,
} from "@/lib/format";
import { normalizeSearchTerm } from "@/lib/highlight";
import { linkifyText } from "@/lib/linkify";
import { formatLanguageName, isDisplayableLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { extractReplyHandles } from "@/lib/reply-handles";
import type { Bookmark, MediaItem, QuotedTweet } from "@/types/bookmark";

// Both Bookmark and QuotedTweet share these fields, so layouts/title/description
// can read them off the target without caring about kind.
function getTweet(t: { kind: "bookmark"; bookmark: Bookmark } | { kind: "quote"; quote: QuotedTweet }) {
  return t.kind === "bookmark" ? t.bookmark : t.quote;
}

export function Lightbox() {
  const { target, close } = useLightbox();
  const isMobile = useIsMobile();
  const [index, setIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!target) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs index to external `target` prop
      setIndex(0);
      return;
    }
    const urls = getTweet(target).media.map((m) => m.url);
    const idx = target.mediaUrl ? urls.indexOf(target.mediaUrl) : 0;
    setIndex(idx < 0 ? 0 : idx);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const count = getTweet(target).media.length;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight")
        setIndex((i) => Math.min(count - 1, i + 1));
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [target]);

  // Pause active video when target changes or dialog unmounts — Radix unmount
  // alone doesn't stop playback mid-transition.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.pause();
    };
  }, [target, index]);

  if (!target) return null;

  const tweet = getTweet(target);
  const media = tweet.media;
  const textOnly = media.length === 0;
  const hasNav = media.length > 1;
  const current: MediaItem | undefined = media[index];
  // If the Dialog is open but we somehow don't have a media item (e.g. index
  // drift during reload), bail out — guard is safer than a non-null assertion.
  if (!textOnly && !current) return null;

  // Side panel branches on kind: real bookmarks get the full panel
  // (engagement, categories, archive); quote-snapshots get the slimmer
  // LightboxQuotePanel which only renders fields a quote actually has.
  const sidePanel =
    target.kind === "bookmark" ? (
      <LightboxCardPanel bookmark={target.bookmark} currentMedia={current} />
    ) : (
      <LightboxQuotePanel quote={target.quote} />
    );

  return (
    <Dialog open={!!target} onOpenChange={(isOpen) => !isOpen && close()}>
      <DialogPortal>
        <DialogOverlay className="supports-backdrop-filter:backdrop-blur-lg" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
          <DialogTitle className="sr-only">
            {target.kind === "bookmark" ? "Bookmark" : "Quoted tweet"} from @{tweet.authorHandle}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {tweet.text || "Detail view"}
          </DialogDescription>

          {textOnly ? (
            <TextOnlyLayout sidePanel={sidePanel} onClose={close} />
          ) : isMobile ? (
            <MobileLayout
              sidePanel={sidePanel}
              current={current as MediaItem}
              media={media}
              index={index}
              setIndex={setIndex}
              hasNav={hasNav}
              onClose={close}
              videoRef={videoRef}
            />
          ) : (
            <DesktopLayout
              sidePanel={sidePanel}
              current={current as MediaItem}
              media={media}
              index={index}
              setIndex={setIndex}
              hasNav={hasNav}
              onClose={close}
              videoRef={videoRef}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

// ─── Layouts ──────────────────────────────────────────────────────────────────

type LayoutProps = {
  // Pre-built side panel (bookmark or quote variant). The layouts don't need
  // to know which kind they're rendering — they just slot the panel into the
  // right column. Kind branching happens once at the Lightbox top-level.
  sidePanel: ReactNode;
  current: MediaItem;
  media: MediaItem[];
  index: number;
  setIndex: Dispatch<SetStateAction<number>>;
  hasNav: boolean;
  onClose: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
};

// Single click handler that closes the dialog unless the click landed on an
// interactive element or an explicitly-marked "keep" region (the card panel).
function makeBackdropHandler(onClose: () => void) {
  return (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a, img, video, [data-lb-keep]")) return;
    onClose();
  };
}

function DesktopLayout({
  sidePanel,
  current,
  media,
  index,
  setIndex,
  hasNav,
  onClose,
  videoRef,
}: LayoutProps) {
  return (
    <div
      onClick={makeBackdropHandler(onClose)}
      className="grid h-full w-full grid-cols-[48px_1fr_48px_400px] gap-4 p-5"
    >
      {/* Col 1: close (top spacer) · prev (center) · palette (bottom spacer).
          Both spacers are flex-1 so the prev button sits at the true column
          center regardless of close/palette heights. */}
      <div className="flex flex-col items-center">
        <div className="flex flex-1 flex-col items-center">
          <Button variant="secondary" size="icon-lg" onClick={onClose} aria-label="Close">
            <RiCloseLine />
          </Button>
        </div>
        {hasNav && (
          <Button
            variant="secondary"
            size="icon-lg"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            aria-label="Previous"
          >
            <RiArrowLeftSLine />
          </Button>
        )}
        <div className="flex flex-1 flex-col items-center justify-end">
          {current.colors && <LightboxPalette media={current} />}
        </div>
      </div>

      {/* Col 2: media + thumbs */}
      <div className="flex min-h-0 flex-col items-center justify-center gap-3">
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          <LightboxMedia media={current} videoRef={videoRef} />
        </div>
        {hasNav && (
          <LightboxThumbs media={media} activeIndex={index} onSelect={setIndex} />
        )}
      </div>

      {/* Col 3: next arrow (centered) */}
      <div className="flex items-center justify-center">
        {hasNav && (
          <Button
            variant="secondary"
            size="icon-lg"
            onClick={() => setIndex((i) => Math.min(media.length - 1, i + 1))}
            disabled={index === media.length - 1}
            aria-label="Next"
          >
            <RiArrowRightSLine />
          </Button>
        )}
      </div>

      {/* Col 4: card panel — data-lb-keep so body clicks don't dismiss */}
      <div
        data-lb-keep
        className="bg-card text-card-foreground flex min-h-0 flex-col overflow-hidden rounded-lg border"
      >
        {sidePanel}
      </div>
    </div>
  );
}

function MobileLayout({
  sidePanel,
  current,
  media,
  index,
  setIndex,
  hasNav,
  onClose,
  videoRef,
}: LayoutProps) {
  return (
    <div
      onClick={makeBackdropHandler(onClose)}
      className="flex h-full w-full flex-col gap-3 p-3"
    >
      {/* Top bar: close */}
      <div className="flex items-center justify-end">
        <Button variant="secondary" size="icon-lg" onClick={onClose} aria-label="Close">
          <RiCloseLine />
        </Button>
      </div>

      {/* Media with floating nav arrows */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <LightboxMedia media={current} videoRef={videoRef} />
        {hasNav && (
          <>
            <div className="absolute left-1 top-1/2 -translate-y-1/2">
              <Button
                variant="secondary"
                size="icon-lg"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                aria-label="Previous"
              >
                <RiArrowLeftSLine />
              </Button>
            </div>
            <div className="absolute right-1 top-1/2 -translate-y-1/2">
              <Button
                variant="secondary"
                size="icon-lg"
                onClick={() => setIndex((i) => Math.min(media.length - 1, i + 1))}
                disabled={index === media.length - 1}
                aria-label="Next"
              >
                <RiArrowRightSLine />
              </Button>
            </div>
          </>
        )}
      </div>

      {hasNav && (
        <LightboxThumbs media={media} activeIndex={index} onSelect={setIndex} />
      )}

      {/* Palette (horizontal on mobile) — component renders its own flex-wrap */}
      {current.colors && <LightboxPalette media={current} horizontal />}

      {/* Card panel — data-lb-keep prevents body clicks from dismissing */}
      <div
        data-lb-keep
        className="bg-card text-card-foreground flex max-h-[45vh] min-h-0 flex-col overflow-hidden rounded-lg border"
      >
        {sidePanel}
      </div>
    </div>
  );
}

function TextOnlyLayout({
  sidePanel,
  onClose,
}: {
  sidePanel: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={makeBackdropHandler(onClose)}
      className="flex h-full w-full items-center justify-center p-5"
    >
      <div
        data-lb-keep
        className="bg-card text-card-foreground relative flex max-h-[80vh] w-full max-w-[500px] flex-col overflow-hidden rounded-lg border shadow-xl"
      >
        <div className="absolute top-2 right-2 z-10">
          <Button variant="secondary" size="icon-lg" onClick={onClose} aria-label="Close">
            <RiCloseLine />
          </Button>
        </div>
        {sidePanel}
      </div>
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function LightboxMedia({
  media,
  videoRef,
}: {
  media: MediaItem;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  // Placeholder: source data has the media item but no file is on disk
  // yet. Lightbox can be reached for a placeholder when the user clicks
  // the card body (not the placeholder itself, which is non-interactive)
  // — bookmark text or footer would still open the bookmark's lightbox,
  // and that bookmark's media[0] could be a placeholder.
  if (!media.url && !media.thumb) {
    return (
      <MediaPlaceholder
        className="max-h-full max-w-full"
        style={
          media.width && media.height
            ? { aspectRatio: `${media.width} / ${media.height}`, width: "min(80vw, 800px)" }
            : { width: "min(80vw, 800px)", height: "min(60vh, 600px)" }
        }
      />
    );
  }
  if (media.type === "video" || media.type === "animated_gif") {
    return (
      <video
        ref={videoRef}
        src={media.url ?? undefined}
        controls
        autoPlay
        playsInline
        loop={media.type === "animated_gif"}
        muted={media.type === "animated_gif"}
        className="max-h-full max-w-full object-contain"
      />
    );
  }
  return (
    <img
      src={media.url ?? undefined}
      alt=""
      className="max-h-full max-w-full object-contain"
    />
  );
}

function LightboxPalette({
  media,
  horizontal = false,
}: {
  media: MediaItem;
  horizontal?: boolean;
}) {
  if (!media.colors) return null;
  // Surface matches shadcn's PopoverContent (bg-popover + ring-1 ring-foreground/10,
  // src/components/ui/popover.tsx:33) so the floating palette reads as part of
  // the same family of floating UI surfaces. 6px padding = (32px button − 20px
  // swatch) / 2, so the column width snaps to the button width.
  const surface =
    "rounded-full bg-popover p-1.5 text-popover-foreground ring-1 ring-foreground/10";
  return (
    <div
      className={
        horizontal
          ? `${surface} flex flex-wrap items-center gap-2`
          : `${surface} flex max-h-[60vh] flex-col items-center gap-2 overflow-y-auto`
      }
    >
      {media.colors.palette.map((c, i) => {
        const [r, g, b] = labToRgb(c.L, c.a, c.b);
        const hex = labToHex(c.L, c.a, c.b);
        const pct = Math.round(c.w * 1000) / 10;
        return (
          <PaletteSwatch
            key={i}
            hex={hex}
            pct={pct}
            bg={`rgb(${r}, ${g}, ${b})`}
            side={horizontal ? "top" : "right"}
          />
        );
      })}
    </div>
  );
}

// TODO(a11y): HoverCard opens only on hover — keyboard-only and touch users
// can't reach the Copy / Filter buttons from the palette surface. Copy hex
// here is keyboard-inaccessible; Filter-by-color has a parallel entry via the
// topbar color picker. Revisit at Step 18 — add Enter/Space-on-focused-swatch
// = copy.
function PaletteSwatch({
  hex,
  pct,
  bg,
  side,
}: {
  hex: string;
  pct: number;
  bg: string;
  side: "top" | "right";
}) {
  const { state: copyState, copy } = useCopyFeedback(1000);
  const { dispatch, clearAll } = useFilter();
  const { close } = useLightbox();

  const filterByThisColor = () => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    clearAll();
    dispatch({ type: "setColor", color: { hex: hex.toLowerCase(), h, s, v } });
    close();
  };

  return (
    <HoverCard openDelay={100} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`Color ${hex}`}
          className="focus-visible:ring-ring size-5 shrink-0 rounded-full shadow-sm outline-none focus-visible:ring-2"
          style={{ backgroundColor: bg }}
        />
      </HoverCardTrigger>
      <HoverCardContent side={side} className="w-auto rounded-xl p-1 text-xs" sideOffset={8}>
        <ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy(hex)}
            className="font-mono uppercase"
          >
            <RiFileCopyLine />
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : `${hex} ${pct}%`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={filterByThisColor}
            aria-label="Filter by this color"
          >
            <RiFilter3Line />
          </Button>
        </ButtonGroup>
      </HoverCardContent>
    </HoverCard>
  );
}

function LightboxThumbs({
  media,
  activeIndex,
  onSelect,
}: {
  media: MediaItem[];
  activeIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto py-1">
      {media.map((m, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelect(i)}
          className={
            // `border-white`, not `border-primary`: the lightbox overlay is
            // `bg-black/80` regardless of app theme, so the thumb sits in a
            // forced-dark visual context. `border-primary` flips to near-black
            // in light theme and disappears against the dark backdrop.
            "size-14 shrink-0 overflow-hidden rounded border-2 " +
            (i === activeIndex ? "border-white" : "border-transparent")
          }
        >
          <img
            src={m.thumb ?? m.url ?? undefined}
            alt=""
            className="bg-muted h-full w-full object-cover"
          />
        </button>
      ))}
    </div>
  );
}

function LightboxCardPanel({
  bookmark,
  currentMedia,
}: {
  bookmark: Bookmark;
  // The media item the user is currently viewing — drives the per-image
  // dimensions row in the Details grid. Undefined for text-only bookmarks
  // (the row is suppressed).
  currentMedia?: MediaItem;
}) {
  const {
    id,
    authorHandle,
    authorName,
    pfp,
    postedAt,
    syncedAt,
    language,
    url,
    links,
    text,
    isThread,
    quotedTweet,
    quotedStatusId,
    engagement,
    primary_category,
    categories,
    article,
  } = bookmark;
  const { state: filterState, dispatch } = useFilter();
  const { close } = useLightbox();
  const { isHidden } = useHidden();
  const { activeTab } = useTab();
  const search = normalizeSearchTerm(filterState.search);
  const expanded = expandTcoLinks(text || "", links);
  const { handles, rest } = extractReplyHandles(expanded);

  // De-duplicate while preserving primary first, mirroring `ft show` which
  // prints primary_category · primary_domain inline and the full categories
  // list separately.
  const orderedCategories = primary_category
    ? [primary_category, ...categories.filter((c) => c !== primary_category)]
    : categories;

  // Click a chip → replace the category filter with *just* this category and
  // dismiss the lightbox. Not a toggle — if the user already had other
  // categories selected, this collapses them down to the one they clicked
  // (intent: "show me more like this one"). Same pattern as the palette
  // swatch's "filter by this color" button.
  const filterByCategory = (c: string) => {
    dispatch({ type: "setCategories", categories: new Set([c]) });
    close();
  };
  // Click the Language value in the Details grid → replace the language
  // filter with just this code, dismiss the lightbox. Same intent as the
  // category-chip filter ("show me more like this one"), surfaced through
  // a different gesture because Details rows don't read as filterable
  // chips by default.
  const filterByLanguage = (lang: string) => {
    dispatch({ type: "setLanguages", languages: new Set([lang]) });
    close();
  };
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5 text-sm">
      <AuthorLink
        handle={authorHandle}
        name={authorName}
        pfp={pfp}
        size="md"
        highlight={search}
      />

      <ReplyOrThreadPills
        handles={handles}
        isThread={isThread}
        isArchived={isHidden(id) && activeTab === "duplicates"}
        url={url}
      />

      {/* For X Articles, the tweet text is just the t.co linking to the
          article. Three states (matches BookmarkCard):
            - article enriched   → full reading view (title + paragraphs)
            - X Article URL only → ArticleBlockPending placeholder (same
              shape as the card placeholder so the user sees a consistent
              "not yet synced" affordance regardless of where they hit it)
            - regular tweet      → tweet text as before
          Body is split on `\n` so each paragraph gets proper inter-
          paragraph spacing; ft's `plain_text` extraction uses single
          `\n` per paragraph break, so this matches the article's
          intended structure. */}
      {article ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg leading-snug font-semibold">
            {article.title}
          </h2>
          <div className="flex flex-col gap-3">
            {article.text
              .split("\n")
              .filter((p) => p.trim() !== "")
              .map((para, i) => (
                <p key={i} className="break-words">
                  {linkifyText(para, search)}
                </p>
              ))}
          </div>
        </div>
      ) : links.some((l) => l.includes("/i/article/")) ? (
        <ArticleBlockPending />
      ) : (
        rest && (
          <p className="break-words whitespace-pre-wrap">
            {linkifyText(rest, search)}
          </p>
        )
      )}

      {(quotedTweet || quotedStatusId) && (
        <QuotedTweetCard quote={quotedTweet ?? null} />
      )}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground self-start text-xs tabular-nums hover:underline"
      >
        {fmtAbsoluteDate(postedAt)}
      </a>

      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs tabular-nums">
        <Stat icon={<RiChat3Line className="size-4" />} value={engagement.replyCount} />
        <Stat icon={<RiRepeatLine className="size-4" />} value={engagement.repostCount} />
        <Stat icon={<RiHeart3Line className="size-4" />} value={engagement.likeCount} />
        <Stat icon={<RiBookmarkLine className="size-4" />} value={engagement.bookmarkCount} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <RiMoreFill />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <BookmarkMenuItems bookmark={bookmark} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DetailsGrid
        id={id}
        quoteCount={engagement.quoteCount}
        language={language}
        onFilterByLanguage={filterByLanguage}
        currentMedia={currentMedia}
        syncedAt={syncedAt}
      />

      {orderedCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {orderedCategories.map((c) => (
            // Badge's outline variant gates hover behind `[a]:` (anchor only),
            // so for the filter-action <button> case we re-add hover styling
            // to match the affordance the [a]: rule provides for navigation
            // pills. cursor-pointer because <button> doesn't have it by default
            // when there's no role/type-driven UA style.
            <Badge
              key={c}
              variant="outline"
              asChild
              className="cursor-pointer hover:bg-muted hover:text-muted-foreground"
            >
              <button type="button" onClick={() => filterByCategory(c)}>
                {c}
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, value }: { icon: React.ReactNode; value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {fmtNum(value)}
    </span>
  );
}

// Two-column key/value grid surfacing tweet metadata that doesn't fit in
// the engagement row or category chips: tweet id, current media dimensions,
// last sync time, and quote count. Modeled on are.na's item-detail table —
// muted labels, bold right-aligned values. Tweet ID is always shown; other
// rows are conditional on data presence so the panel doesn't carry empty
// slots for text-only or never-quoted bookmarks.
function DetailsGrid({
  id,
  quoteCount,
  language,
  onFilterByLanguage,
  currentMedia,
  syncedAt,
}: {
  id: string;
  quoteCount: number;
  language: string;
  onFilterByLanguage: (lang: string) => void;
  currentMedia: MediaItem | undefined;
  syncedAt: string | null;
}) {
  const showMedia = !!(currentMedia && currentMedia.width && currentMedia.height);
  const showSynced = !!syncedAt;
  const showQuotes = quoteCount > 0;
  const showLanguage = isDisplayableLanguage(language);

  // Click the Tweet ID → copy to clipboard, flip the value to "COPIED" (or
  // "COPY FAILED") for 2s. Navigating to another bookmark resets it so the
  // feedback never shows against a different id.
  const { state: idCopy, copy: copyId, reset: resetIdCopy } =
    useCopyFeedback(2000);
  useEffect(() => {
    resetIdCopy();
  }, [id, resetIdCopy]);
  const idCopied = idCopy !== "idle";
  const idCopyLabel = idCopy === "failed" ? "Copy failed" : "Copied";

  return (
    // Negative horizontal margins extend the top border beyond the parent
    // panel's `p-5` so the line runs flush to the panel edges (matches
    // are.na's full-bleed separators); inner padding is re-added so the
    // title and rows sit at the same horizontal alignment as the rest of
    // the panel content.
    <div className="-mx-5 border-t px-5 pt-5">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
        Details
      </h3>
      <dl className="divide-y border-b text-xs">
        {showQuotes && (
          <div className="flex items-center gap-4 py-1.5">
            <dt className="text-muted-foreground">Quotes</dt>
            <dd className="min-w-0 flex-1 tabular-nums text-right">{fmtNum(quoteCount)}</dd>
          </div>
        )}
        <div className="flex items-center gap-4 py-1.5">
          <dt className="text-muted-foreground">Tweet ID</dt>
          <dd className="min-w-0 flex-1 text-right">
            <button
              type="button"
              onClick={() => void copyId(id)}
              aria-label={idCopied ? idCopyLabel : `Copy tweet ID ${id}`}
              title={idCopied ? idCopyLabel : "Click to copy"}
              className={cn(
                // Same width-stable swap pattern as CopyableCode: button is
                // an inline-grid with two layered cells, the invisible span
                // reserves the id's width so the shorter COPIED text
                // doesn't shrink the button on click. Hover bg matches
                // CopyableCode's look; the copied state holds the bg until
                // the text reverts so the click target reads as "still
                // engaged" until the transient feedback ends.
                "inline-grid max-w-full cursor-pointer grid-cols-1 rounded-sm px-1 font-mono hover:bg-foreground/10",
                idCopied && "bg-foreground/10",
              )}
            >
              <span
                className="invisible col-start-1 row-start-1 truncate text-right"
                aria-hidden
              >
                {id}
              </span>
              <span
                className={cn(
                  "col-start-1 row-start-1 truncate",
                  idCopied ? "text-center" : "text-right",
                )}
              >
                {idCopied ? idCopyLabel.toUpperCase() : id}
              </span>
            </button>
          </dd>
        </div>
        {showLanguage && (
          <div className="flex items-center gap-4 py-1.5">
            <dt className="text-muted-foreground">Language</dt>
            <dd className="min-w-0 flex-1 text-right">
              <button
                type="button"
                onClick={() => onFilterByLanguage(language)}
                title={language.toUpperCase()}
                className="max-w-full cursor-pointer truncate text-right hover:underline"
              >
                {formatLanguageName(language)}
              </button>
            </dd>
          </div>
        )}
        {showMedia && (
          <div className="flex items-center gap-4 py-1.5">
            <dt className="text-muted-foreground">Media</dt>
            <dd className="min-w-0 flex-1 tabular-nums text-right">
              {mediaTypeLabel(currentMedia!.type)} · {currentMedia!.width} × {currentMedia!.height}
            </dd>
          </div>
        )}
        {showSynced && (
          <div className="flex items-center gap-4 py-1.5">
            <dt className="text-muted-foreground">Synced</dt>
            <dd className="min-w-0 flex-1 text-right">{fmtRelativeDate(syncedAt)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function mediaTypeLabel(type: MediaItem["type"]): string {
  if (type === "video") return "Video";
  if (type === "animated_gif") return "GIF";
  return "Photo";
}


// Slim panel for quote-snapshot targets (a tweet that exists in our data only
// because something we bookmarked quoted it). Renders only what a QuotedTweet
// actually carries: author, date, text, media. No engagement (we don't have
// counts), no categories (never classified), no archive (it's not bookmarked,
// so the action would be meaningless). The "Not bookmarked" badge under the
// author makes the quote-vs-bookmark distinction explicit instead of leaving
// it implicit in "fewer affordances".
function LightboxQuotePanel({ quote }: { quote: QuotedTweet }) {
  const { state: filterState } = useFilter();
  const search = normalizeSearchTerm(filterState.search);
  // Quote snapshots don't carry the t.co links table, so expansion is a no-op.
  // The trailing self-link is already stripped server-side in loadBookmarks.
  const text = quote.text || "";
  const { handles, rest } = extractReplyHandles(text);

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5 text-sm">
      <AuthorLink
        handle={quote.authorHandle}
        name={quote.authorName}
        pfp={quote.pfp}
        size="md"
        highlight={search}
      />

      <Badge variant="outline" className="self-start">
        <RiChatQuoteLine />
        Not bookmarked
      </Badge>

      <ReplyOrThreadPills handles={handles} isThread={false} url={quote.url} />

      {rest && (
        <p className="break-words whitespace-pre-wrap">
          {linkifyText(rest, search)}
        </p>
      )}

      <a
        href={quote.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground self-start text-xs tabular-nums hover:underline"
      >
        {fmtAbsoluteDate(quote.postedAt)}
      </a>
    </div>
  );
}

