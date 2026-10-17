import { memo, useEffect, useRef } from "react";
import { CardVideo } from "@/components/card-video";
import { MediaPlaceholder } from "@/components/media-placeholder";
import { Checkbox } from "@/components/ui/checkbox";
import { useLightbox } from "@/contexts/lightbox-context";
import { useSelection } from "@/contexts/selection-context";
import { useSettings } from "@/contexts/settings-context";
import type { GalleryItem } from "@/lib/filter";
import { cn } from "@/lib/utils";

// Minimal media tile for the Gallery view. Click → lightbox at this media.
// Selection checkbox appears on hover (or stays visible when the parent
// bookmark is already selected). No archive button — Gallery is meant to be
// pure browsing surface.
//
// TODO: revisit whether Gallery should expose selection at all. A bookmark
// with multiple media items shows the same selected state on every tile,
// which can read as "this image is selected" instead of "this bookmark is".
// Options to weigh later: drop selection from Gallery entirely, or keep it
// but visually indicate that selection is bookmark-scoped (e.g. show all of
// the bookmark's tiles together when one is checked).
// Memoized so resize-driven layout recomputes (which re-render the parent
// list ~12 times across a sidebar transition) don't reflow every visible
// card body. With memo, an unchanged card with stable props skips its
// own render entirely; only the wrapper div's inline style updates.
export const GalleryCard = memo(function GalleryCard({
  item,
  scrollSettled = true,
  isInViewport = false,
}: {
  item: GalleryItem;
  // Scroll-aware video mounting — both flags feed CardVideo, which owns
  // the mitigation (poster <img> during fast scroll, 50 ms viewport
  // hold-off, fetch cancellation). See card-video.tsx for the full why.
  scrollSettled?: boolean;
  isInViewport?: boolean;
}) {
  const { bookmark, media } = item;
  const { open: openLightbox } = useLightbox();
  const { isSelected, toggle } = useSelection();
  const { settings } = useSettings();
  const selected = isSelected(bookmark.id);
  const autoplay = settings.autoplayVideos;

  const src = media.thumb ?? media.url;
  const isVideoType = media.type === "video" || media.type === "animated_gif";

  // Cancel an in-flight photo fetch on unmount: clearing `src` aborts the
  // request. (The video-side equivalent lives in CardVideo.)
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = imgRef.current;
    return () => {
      if (img) img.src = "";
    };
  }, []);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Unlike bookmark-card, Gallery has no non-media click target, so video
    // clicks must bubble up to open the lightbox. We don't exclude `video`
    // here — the trade-off is no inline playback controls on Gallery tiles
    // (matches the pure-browsing intent of this surface).
    if (target.closest('button, [role="checkbox"]')) return;
    // Placeholder media has no file to view; ignore the click rather
    // than opening lightbox to nothing.
    if (!media.url) return;
    openLightbox(bookmark, media.url);
  };

  return (
    // Card fills its wrapper exactly. Wrapper (provided by GalleryList)
    // sizes itself from media.width/media.height — heights are exact data,
    // not measured, so no aspect-ratio CSS is needed here.
    <article
      className={cn(
        "group bg-muted relative h-full w-full cursor-zoom-in overflow-hidden rounded-md",
        selected && "ring-primary ring-2"
      )}
      onClick={handleClick}
    >
      {!media.url && !media.thumb ? (
        <MediaPlaceholder className="h-full w-full" />
      ) : isVideoType ? (
        <CardVideo
          url={media.url}
          poster={media.thumb}
          autoplay={autoplay}
          scrollSettled={scrollSettled}
          isInViewport={isInViewport}
          // box geometry only — CardVideo's layers apply object-cover inside
          className="h-full w-full"
        />
      ) : (
        // Photos. No `loading="lazy"`: virtualization already handles
        // "only mount near viewport," which is a stronger guarantee than
        // the browser's own lazy heuristic. fetchPriority="high" pairs
        // with CardVideo's "low" so thumbs win the queue when both are
        // competing for slots.
        <img
          ref={imgRef}
          src={src ?? undefined}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}

      <div
        className={cn(
          "absolute top-2 right-2 transition-opacity",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      >
        <Checkbox
          aria-label={`Select bookmark from @${bookmark.authorHandle}`}
          checked={selected}
          onCheckedChange={() => toggle(bookmark.id)}
          onClick={(e) => e.stopPropagation()}
          className="bg-background/80 backdrop-blur-sm"
        />
      </div>
    </article>
  );
});
