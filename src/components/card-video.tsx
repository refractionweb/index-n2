import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLightbox } from "@/contexts/lightbox-context";
import { cn } from "@/lib/utils";

// Video tile shared by GalleryCard and BookmarkCard's MediaThumb — owns the
// scroll-aware mount strategy so the mitigation lives once.
//
// Mount strategy: <video autoPlay> overrides preload="none" and fires a
// 3–4 MB range GET on every mount. During a fast scrollbar drag that's
// hundreds of mp4 fetches, each holding one of the 6-per-origin connection
// slots, queueing the small thumbs the user actually wants to see. So while
// autoplay is on, the video element mounts only when the tile has been
// stably in the viewport for 50 ms or scrolling has settled. With autoplay
// OFF there is nothing to mitigate — an inert <video preload="none">
// fetches nothing until the user presses play — so the video mounts
// unconditionally and no swap (hence no swap artifact) ever occurs.
//
// Render strategy: the poster renders as a persistent <img> with the
// <video> layered on top, revealed only once frames are actually advancing
// (first timeupdate with currentTime > 0). Safari 15.4+ has an open bug
// where a freshly-mounted autoplay+poster video paints blank between
// hiding the poster and presenting the first frame (videojs/video.js#7748;
// reproduced here in headed WebKit as a full blank frame at the swap).
// The underlay means there is never a moment where the box has nothing to
// paint: the poster never unmounts, and the video only covers it when it
// can genuinely show a frame. The autoplay+poster attribute combination —
// the exact trigger of the WebKit bug — is avoided entirely (the attr is
// only set in controls mode, where it's stable).
//
// Box contract: the wrapper carries the caller's geometry (className/
// style — aspect-ratio, h/w, grid minHeight); both layers fill it with
// object-cover internally. Heights therefore never vary with scroll or
// load state, which BookmarkList's height predictor depends on.
//
// `data-card-video` on the wrapper lets BookmarkCard's click guard treat
// the whole tile like the <video> it contains.
export function CardVideo({
  url,
  poster,
  autoplay,
  scrollSettled = true,
  isInViewport = false,
  controls = false,
  hoverControls = false,
  className,
  style,
}: {
  url: string | null;
  poster: string | null;
  autoplay: boolean;
  scrollSettled?: boolean;
  isInViewport?: boolean;
  controls?: boolean;
  // Reveal native controls only while hovered (autoplay preview mode).
  hoverControls?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  // 50 ms hold-off: only treat the tile as "stably in viewport" once it's
  // been there continuously for ~50 ms. Items that just briefly pass through
  // the viewport during fast scroll never clear this threshold and so never
  // mount a <video>. Slow / reading scroll dwell times are well above 50 ms,
  // so the delay is imperceptible there.
  const [stableInViewport, setStableInViewport] = useState(false);
  useEffect(() => {
    if (!isInViewport) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hold-off reset on viewport exit; runs only on isInViewport transitions so it can't cascade
      setStableInViewport(false);
      return;
    }
    const t = setTimeout(() => setStableInViewport(true), 50);
    return () => clearTimeout(t);
  }, [isInViewport]);

  const showVideo = !autoplay || stableInViewport || scrollSettled;

  // Cancel an in-flight poster fetch on unmount; setup re-applies the src
  // because the cleanup strips it behind React's back and re-renders never
  // restore it (StrictMode's dev-only setup→cleanup→setup would otherwise
  // leave the poster permanently blank).
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = imgRef.current;
    if (img && poster && !img.getAttribute("src")) img.src = poster;
    return () => {
      if (img) img.src = "";
    };
  }, [poster]);

  return (
    <div data-card-video className={cn("relative", className)} style={style}>
      {poster && (
        // fetchPriority="high" pairs with the video's "low" so posters win
        // the connection-slot queue when both are competing during scroll.
        <img
          ref={imgRef}
          src={poster}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {showVideo && url && (
        <VideoLayer
          url={url}
          poster={poster}
          autoplay={autoplay}
          controls={controls}
          hoverControls={hoverControls}
        />
      )}
    </div>
  );
}

// Inner component so its lifecycle equals the <video> element's: the
// `revealed` state is born false on every mount and dies with it — no
// cross-mount reset bookkeeping.
function VideoLayer({
  url,
  poster,
  autoplay,
  controls,
  hoverControls,
}: {
  url: string;
  poster: string | null;
  autoplay: boolean;
  controls: boolean;
  hoverControls: boolean;
}) {
  const { target: lightboxTarget } = useLightbox();
  const videoRef = useRef<HTMLVideoElement>(null);

  // Hidden until frames are provably advancing. Community reports on the
  // Safari bug note that even the `playing` event can fire before the
  // first frame paints; currentTime > 0 on timeupdate is the reliable
  // signal. Without a poster there's nothing to hide behind, so reveal
  // immediately. In controls mode (`!autoplay`) the video is always shown
  // — see `shown` below — and displays its own stable poster attr.
  const [revealed, setRevealed] = useState(!poster);
  const shown = revealed || !autoplay;

  // Pause playback while the lightbox is open. The <video> element stays
  // mounted so the mp4 buffer is preserved — on close, .play() resumes
  // from the paused position instead of restarting. Pause does NOT abort
  // the in-flight mp4 fetch; this is CPU/decode/battery relief, not
  // connection-slot relief. (A pause before first reveal simply leaves the
  // poster underlay showing — correct for a video paused at 0.)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (lightboxTarget) {
      v.pause();
    } else if (autoplay) {
      void v.play().catch(() => {});
    }
  }, [lightboxTarget, autoplay]);

  // Cancel the in-flight mp4 range GET on unmount: clearing `src` and
  // calling `load()` resets the media element, which aborts its network
  // activity. Setup re-applies the src for the same StrictMode reason as
  // the poster effect above.
  useEffect(() => {
    const v = videoRef.current;
    if (v && !v.getAttribute("src")) {
      v.setAttribute("src", url);
      v.load();
      if (autoplay) void v.play().catch(() => {});
    }
    return () => {
      if (v) {
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [url, autoplay]);

  return (
    <video
      ref={videoRef}
      src={url}
      // The autoplay+poster attribute combo is the WebKit flicker trigger —
      // poster attr only in controls mode, where the underlay isn't needed.
      poster={autoplay ? undefined : (poster ?? undefined)}
      autoPlay={autoplay}
      muted={autoplay}
      loop={autoplay}
      playsInline
      preload="none"
      controls={controls}
      onMouseEnter={
        hoverControls ? (e) => (e.currentTarget.controls = true) : undefined
      }
      onMouseLeave={
        hoverControls ? (e) => (e.currentTarget.controls = false) : undefined
      }
      onTimeUpdate={(e) => {
        if (e.currentTarget.currentTime > 0) setRevealed(true);
      }}
      // @ts-expect-error: fetchPriority on <video> isn't in React's typings
      // yet, but React lowercases it to the fetchpriority attribute, which
      // Chromium/WebKit honor.
      fetchPriority="low"
      className={cn(
        "absolute inset-0 h-full w-full object-cover",
        !shown && "opacity-0"
      )}
    />
  );
}
