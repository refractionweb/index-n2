import { useLayoutEffect, useRef } from "react";
import type { Bookmark } from "@/types/bookmark";

// Horizontal stack of the last 3 selected bookmarks, rendered in the selection
// bar. DOM is managed imperatively in a useLayoutEffect (no per-card React
// transition library). Behavior:
// - Select: new card slides + fades in from the right, on top; the oldest card
//   slides out to the left and fades.
// - Deselect: the window slides back — the revealed card fades in at the left
//   behind its neighbours; the removed card is z-demoted and slides under.
// - Missing media renders the shared grey/cross <MediaPlaceholder>; images are
//   pre-sized from source metadata so the animation plays on a real box.
// - Every card sits on its own compositing layer (translateZ) so z-index holds
//   mid-transition. Inline comments cover the why behind each of these.

const CARD_W = 36; // long side of a non-square card; also the layout footprint
const CARD_SQUARE = 32; // 1:1 media and the "Aa" text card
const STEP = Math.round(CARD_W * 0.45); // 45% exposed per card
const MAGS = [8, 10, 12] as const;
const EXIT_MS = 260;

const SVG_NS = "http://www.w3.org/2000/svg";
// The two diagonals of the "media not downloaded" cross — same geometry as
// <MediaPlaceholder> (media-placeholder.tsx). Rebuilt imperatively here because
// the stack manages its DOM by hand, not through React.
const CROSS_LINES = [
  ["0", "0", "100%", "100%"],
  ["100%", "0", "0", "100%"],
] as const;

// Card footprint for a source aspect ratio: 32px square, else 36px on the long
// side. Returns explicit numbers so a not-yet-loaded <img> or a placeholder
// <div> can reserve a correctly-shaped box before any pixels exist.
const boxFor = (w: number, h: number): { w: number; h: number } => {
  if (!w || !h || w === h) return { w: CARD_SQUARE, h: CARD_SQUARE };
  return w > h
    ? { w: CARD_W, h: Math.round((CARD_W * h) / w) }
    : { w: Math.round((CARD_W * w) / h), h: CARD_W };
};

type Props = {
  ids: string[];
  byId: ReadonlyMap<string, Bookmark>;
};

export function SelectionStack({ ids, byId }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stack = ref.current;
    if (!stack) return;

    const visible = ids.slice(-3);

    // Deterministic rotation based on the first-ever selected id so the
    // initial lean direction persists across the session.
    const firstEver = ids[0] || "";
    let h = 0;
    for (const ch of firstEver) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const startSign = h & 1 ? 1 : -1;
    const rotFor = (id: string): number => {
      const idx = ids.indexOf(id);
      const sign = startSign * (idx % 2 === 0 ? 1 : -1);
      return sign * MAGS[idx % MAGS.length];
    };

    stack.style.width = visible.length
      ? `${(visible.length - 1) * STEP + CARD_W}px`
      : "0px";

    const existing = new Map<string, HTMLElement>();
    stack.querySelectorAll<HTMLElement>("[data-stack-id]").forEach((el) => {
      existing.set(el.dataset.stackId!, el);
    });
    // "First card" = the stack is visually empty. Count all children, including
    // any still animating out — not just live (data-stack-id) nodes — so a card
    // added while others are leaving still slides in rather than popping.
    const isFirstCard = stack.children.length === 0;

    const createEl = (id: string): HTMLElement | null => {
      const b = byId.get(id);
      if (!b) return null;
      // A renderable image = a media item with a file on disk (a thumb, or a
      // photo's original). ft fetches no >1200px variants yet
      // (fieldtheory-cli#153), so `thumb` is almost always the full /media/
      // original (see thumbnails.js) — a heavy decode for a 36px card. Pre-size
      // the box from source metadata (present before the file downloads) so the
      // slide-in plays on a correctly-shaped element instead of a 0×0 one;
      // onload then refines to the exact natural aspect.
      const mediaItem = b.media.find((m) => (m.thumb || m.type === "photo") && (m.thumb || m.url));
      let el: HTMLElement;
      let isPlaceholder = false;
      if (mediaItem) {
        const img = document.createElement("img");
        img.src = mediaItem.thumb ?? mediaItem.url ?? "";
        img.alt = "";
        const apply = () => {
          const nw = img.naturalWidth,
            nh = img.naturalHeight;
          if (!nw || !nh) return;
          if (nw === nh) {
            img.style.width = `${CARD_SQUARE}px`;
            img.style.height = `${CARD_SQUARE}px`;
          } else if (nw > nh) {
            img.style.width = `${CARD_W}px`;
            img.style.height = "auto";
          } else {
            img.style.height = `${CARD_W}px`;
            img.style.width = "auto";
          }
        };
        img.onload = apply;
        if (img.complete) apply();
        else {
          const pre = boxFor(mediaItem.width ?? 0, mediaItem.height ?? 0);
          img.style.width = `${pre.w}px`;
          img.style.height = `${pre.h}px`;
        }
        el = img;
      } else if (b.media.length > 0) {
        // Has media but nothing on disk to show (undownloaded photo, posterless
        // video). Replicate <MediaPlaceholder>'s visual: a muted block with a
        // 1px non-scaling diagonal cross, sized to the source aspect so the grey
        // box stands in for the missing image. No role/aria-label here — the
        // stack is aria-hidden, so they'd never reach a screen reader.
        isPlaceholder = true;
        const ph = document.createElement("div");
        ph.className = "bg-muted text-muted-foreground/15 overflow-hidden";
        const { w, h } = boxFor(b.media[0].width ?? 0, b.media[0].height ?? 0);
        ph.style.width = `${w}px`;
        ph.style.height = `${h}px`;
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "absolute inset-0 h-full w-full");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
        for (const [x1, y1, x2, y2] of CROSS_LINES) {
          const line = document.createElementNS(SVG_NS, "line");
          line.setAttribute("x1", x1);
          line.setAttribute("y1", y1);
          line.setAttribute("x2", x2);
          line.setAttribute("y2", y2);
          line.setAttribute("stroke", "currentColor");
          line.setAttribute("stroke-width", "1");
          line.setAttribute("vector-effect", "non-scaling-stroke");
          svg.appendChild(line);
        }
        ph.appendChild(svg);
        el = ph;
      } else {
        el = document.createElement("div");
        el.textContent = "Aa";
        el.style.width = `${CARD_SQUARE}px`;
        el.style.height = `${CARD_SQUARE}px`;
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
        el.style.fontFamily = "ui-monospace, monospace";
        el.style.fontSize = "11px";
        el.style.color = "rgb(0 0 0 / 0.6)";
      }
      el.dataset.stackId = id;
      el.style.position = "absolute";
      el.style.top = "50%";
      el.style.borderRadius = "6px";
      el.style.border = "2px solid #fff";
      // Placeholder keeps its muted fill (bg-muted); photo and text cards get
      // the white polaroid backing.
      if (!isPlaceholder) el.style.background = "#fff";
      // Hard 1px outer stroke (5% black, no blur) defines the white card edge
      // against light backgrounds; lighter ambient shadow underneath for depth.
      el.style.boxShadow =
        "0 0 0 1px rgba(0,0,0,0.05), 0 0 6px rgba(0,0,0,0.2)";
      el.style.transition = "left .25s ease, opacity .25s ease, transform .15s";
      // translateZ(0) forces every card onto its own compositing layer. The
      // compositor then stacks layers strictly by z-index, even mid-transition.
      // Without it, a fading card is promoted on its own while its siblings are
      // not, and the browser's overlap heuristic lets the promoted layer paint
      // on top regardless of z-index for the transition's duration — the
      // "card jumps on top for a second" artifact on the deselect fade-in.
      el.style.transform = `translateY(-50%) rotate(${rotFor(id)}deg) translateZ(0)`;
      return el;
    };

    visible.forEach((id, i) => {
      const targetLeft = i * STEP;
      const el = existing.get(id);
      if (el) {
        el.style.left = `${targetLeft}px`;
        el.style.opacity = "1";
        el.style.zIndex = String(i);
        existing.delete(id);
      } else {
        const created = createEl(id);
        if (!created) return;
        created.style.zIndex = String(i);
        if (isFirstCard) {
          created.style.left = `${targetLeft}px`;
          created.style.opacity = "1";
          stack.appendChild(created);
        } else if (i === visible.length - 1) {
          // New top card (selection): slide + fade in from just past the right
          // edge, landing on top (it has the highest z-index).
          created.style.left = `${targetLeft + STEP}px`;
          created.style.opacity = "0";
          stack.appendChild(created);
          // Force a synchronous reflow so the browser commits the off-screen
          // start state; the target write below then transitions from it. A
          // requestAnimationFrame would defer the target to the next frame — and
          // if another selection re-runs this effect first, it repositions the
          // card, then the stale rAF fires and slams it back to the old target.
          // Synchronous means there's nothing to race.
          created.getBoundingClientRect();
          created.style.left = `${targetLeft}px`;
          created.style.opacity = "1";
        } else {
          // Card revealed on the left when the window slides back (deselect):
          // fade in at its slot, behind its neighbours (lower z-index). The
          // existing cards sliding right also uncover it. No horizontal slide —
          // sliding in from the left would poke past the stack's left edge. The
          // fade stays behind because translateZ(0) (see createEl) keeps every
          // card on its own layer, so the compositor honors z-index.
          created.style.left = `${targetLeft}px`;
          created.style.opacity = "0";
          stack.appendChild(created);
          created.getBoundingClientRect();
          created.style.opacity = "1";
        }
      }
    });

    // Exit remaining. Drop data-stack-id the instant a card starts leaving, so
    // the querySelectorAll above stops matching it on the next run. Otherwise a
    // card reselected within EXIT_MS gets picked up as "existing" and revived in
    // place — yet its pending removal timer still fires and deletes the now-live
    // node. Without the id, a reselect builds a fresh card that enters cleanly
    // while this one finishes leaving.
    existing.forEach((el) => {
      delete el.dataset.stackId;
      // Drop below every live card (slot z-indexes are >= 0) so a leaving card
      // tucks UNDER the stack as it fades rather than gliding across the top.
      el.style.zIndex = "-1";
      const currentLeft = parseFloat(el.style.left) || 0;
      // Slide off the nearer edge so the exit is always visible: a card leaving
      // from the right end moves right into open space, one from the left end
      // moves left. Sliding everything left hid right-end exits — they slid
      // behind the surviving cards (exits sit at z = -1) and read as no motion.
      const mid = ((visible.length - 1) * STEP) / 2;
      const dir = currentLeft > mid ? 1 : -1;
      el.style.left = `${currentLeft + dir * STEP}px`;
      el.style.opacity = "0";
      window.setTimeout(() => el.remove(), EXIT_MS);
    });
  }, [ids, byId]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="relative isolate h-9 shrink-0 transition-[width] duration-200 ease-out"
    />
  );
}
