import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import {
  computeBookmarkHeightWithBoundary,
  type BoundaryTextSection,
} from "@/lib/compute-bookmark-height";
import { batchMeasureTextHeights } from "@/lib/measure-text-dom";
import type { Bookmark } from "@/types/bookmark";

const GAP = 12;
const OVERSCAN_PX = 800;
const SAMPLE_WIDTHS = [240, 320, 420];
const SNAP_RESET_THRESHOLD = 50;
// Pixel threshold for flagging a wrap decision as "fragile." Lines whose
// canvas-computed width lands within this many pixels of innerWidth are
// at risk of disagreeing with browser layout. Higher = more cards DOM-
// measured (safer, slower); lower = fewer (faster, leaves some boundary
// cases unfixed). 5 px catches all known cases (em-dash overflow ~0.2 px,
// CJK fallback ~3 px, Diego-class subpixel ~3.7 px) with margin.
const BOUNDARY_THRESHOLD_PX = 5;

type Position = { x: number; y: number; w: number; h: number };
type ColumnAnchor = {
  itemIndex: number;
  oldRenderedY: number;
  oldScrollTop: number;
};

function findScrollParent(el: HTMLElement | null): HTMLElement {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return document.documentElement;
}

function capturePerColumnAnchors(
  el: HTMLElement,
  positions: Position[],
  colAssignment: number[],
  columnOffsets: number[],
  cols: number,
): (ColumnAnchor | null)[] {
  const result: (ColumnAnchor | null)[] = new Array(cols).fill(null);
  if (positions.length === 0 || cols === 0) return result;
  const scrollEl = findScrollParent(el);
  const containerTop = el.getBoundingClientRect().top;
  const scrollElTop =
    scrollEl === document.documentElement
      ? 0
      : scrollEl.getBoundingClientRect().top;
  const viewportTop = scrollElTop - containerTop;
  const vh =
    scrollEl === document.documentElement
      ? window.innerHeight
      : scrollEl.clientHeight;
  const viewportBottom = viewportTop + vh;
  const oldScrollTop =
    scrollEl === document.documentElement
      ? window.scrollY
      : scrollEl.scrollTop;

  const bestRenderedY: number[] = new Array(cols).fill(Infinity);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const c = colAssignment[i];
    if (c === undefined || c < 0 || c >= cols) continue;
    const offset = columnOffsets[c] ?? 0;
    const renderedY = p.y + offset;
    if (renderedY + p.h <= viewportTop || renderedY >= viewportBottom) continue;
    if (renderedY < bestRenderedY[c]) {
      bestRenderedY[c] = renderedY;
      result[c] = { itemIndex: i, oldRenderedY: renderedY, oldScrollTop };
    }
  }
  return result;
}

// Focal anchor: a stable scroll reference keyed on bookmark identity, set
// when the user scrolls and persisted across resize cycles. Solves the
// scrollTop drift on round-trip resize that the per-column anchor approach
// can't: per-column re-picks "topmost-visible per column" each RO tick, so
// rapid resize cycles between widths W1 → W2 → W1 anchor against different
// bookmarks at each width, accumulating drift. Focal stays the same across
// the round-trip → same target position → no drift.
//
// Returns null if focalId is missing, or the bookmark has been filtered/
// archived out, or its position can't be resolved. Caller falls back to
// per-column anchors in those cases.
function captureFocalAnchor(
  el: HTMLElement,
  positions: Position[],
  colAssignment: number[],
  columnOffsets: number[],
  cols: number,
  focalId: string | null,
  items: Bookmark[],
): ColumnAnchor | null {
  if (!focalId || positions.length === 0 || cols === 0) return null;
  const idx = items.findIndex((b) => b.id === focalId);
  if (idx < 0) return null;
  const p = positions[idx];
  if (!p) return null;
  const c = colAssignment[idx];
  if (c === undefined || c < 0 || c >= cols) return null;
  const offset = columnOffsets[c] ?? 0;
  const oldRenderedY = p.y + offset;
  const scrollEl = findScrollParent(el);
  const oldScrollTop =
    scrollEl === document.documentElement
      ? window.scrollY
      : scrollEl.scrollTop;
  return { itemIndex: idx, oldRenderedY, oldScrollTop };
}

type PendingAnchors = {
  // Focal-derived primary anchor (drives scrollTop adjustment). Stable
  // across resize cycles because it's keyed on bookmark identity, not
  // viewport snapshot. Null when no focal yet (first paint) or when the
  // focal bookmark has been filtered out.
  primary: ColumnAnchor | null;
  // Per-column captures (drive inter-column offset adjustment). Fresh each
  // RO tick — these are about keeping neighboring columns aligned during a
  // single resize, not about preserving cross-resize identity.
  perColumn: (ColumnAnchor | null)[];
};

// Virtualized masonry list for the home/archive bookmark feed. Heights
// come from canvas-based prediction (compute-bookmark-height.ts) with a
// DOM-measurement fallback for cards whose canvas wrap decision is
// fragile (~2% of cards at any given colW). Boundary-corrected totals
// land in a per-(bookmark, innerWidth) override map and feed back into
// the positions useMemo on the next render.
//
// Anchor logic preserves the user's visible content across width changes
// (window resize, sidebar slide).
export function BookmarkList({
  items,
  columnWidth,
}: {
  items: Bookmark[];
  columnWidth: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // False while the user is actively scrolling (150 ms settle window).
  // Feeds CardVideo's mount strategy via BookmarkCard — see card-video.tsx.
  // Mirrors gallery-list's flag of the same name.
  const [scrollSettled, setScrollSettled] = useState(true);
  const [columnOffsets, setColumnOffsets] = useState<number[]>([]);
  // Override map: (bookmark.id + innerWidth bucket) → corrected total
  // height from DOM measurement. Populated by the boundary-resolution
  // useLayoutEffect after each render that surfaces new boundary
  // candidates.
  const [heightOverrides, setHeightOverrides] = useState<Map<string, number>>(
    () => new Map(),
  );
  // Resize-settle gate. Active resize → DOM batch is deferred so the
  // canvas-only fast path drives during the drag (matches production
  // Home's feel; no 100+ ms paint stall). 150 ms after the last RO
  // tick → settled flips back to true, the boundary effect fires its
  // DOM batch as a one-shot polish, and the anchor effect re-runs to
  // keep visible content put across the correction. Initial true so
  // first paint runs the boundary pass immediately.
  const [resizeSettled, setResizeSettled] = useState(true);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const positionsRef = useRef<Position[]>([]);
  const colAssignmentRef = useRef<number[]>([]);
  const columnOffsetsRef = useRef<number[]>([]);
  const colsRef = useRef<number>(0);
  const itemsRef = useRef<Bookmark[]>(items);
  const pendingAnchorsRef = useRef<PendingAnchors | null>(null);
  // Focal anchor — see captureFocalAnchor for why. Updated by the scroll
  // handler on each scroll event (rAF-coalesced); read by RO/boundary/
  // prevColumnWidth capture sites. Survives resize cycles, only changes
  // when the user actually scrolls.
  const focalBookmarkIdRef = useRef<string | null>(null);
  // Timestamp gate suppressing focal refresh briefly after our own
  // programmatic scrollTop writes. Anchor adjustments fire scroll
  // events that the scroll handler would otherwise treat as user
  // input — rebasing focal to whatever bookmark now straddles the
  // viewport top. That kind of rebase is what *prevents* round-trip
  // exactness across multi-step resizes (e.g. 4→3→2→3→4 across
  // column-count crossings): each step would shift focal one bookmark,
  // accumulating drift. Set this just before any programmatic scroll
  // write; the next ~100 ms of scroll events skip focal refresh and
  // user-driven scrolls beyond that window land normally.
  const programmaticScrollUntilRef = useRef(0);
  // Mirror of resizeSettled state for read inside update() (which
  // closes over its initial values via empty-deps useEffect). Drives
  // the broader-window focal suppression: the 100 ms timestamp gate
  // above catches scroll-event bubbles from individual writes, but
  // during a slow user drag where RO ticks can be 200+ ms apart, that
  // window can lapse between ticks and let a stray scroll event slip
  // through. resizeSettledRef stays false for the entire drag plus
  // the 150 ms settle tail, strictly broader than the timestamp gate.
  const resizeSettledRef = useRef(true);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    let lastW = el.clientWidth;
    let pendingW: number | null = null;
    let rafId = 0;

    // RO callbacks during a CSS-driven width change (sidebar slide,
    // window drag) fire on every layout tick — up to 60/s. The work
    // per tick (anchor capture + setState + downstream renders) is
    // expensive enough to budget. Coalesce to one tick per frame: the
    // RO callback only stashes the latest width, and a rAF callback
    // does the actual work. Multiple intermediate widths within the
    // same frame collapse to the last one. No visual loss — the
    // browser couldn't have painted them anyway.
    const handle = () => {
      rafId = 0;
      if (!el || pendingW === null) return;
      const w = pendingW;
      pendingW = null;
      if (w === lastW) return;

      const perColumn = capturePerColumnAnchors(
        el,
        positionsRef.current,
        colAssignmentRef.current,
        columnOffsetsRef.current,
        colsRef.current,
      );
      const primary = captureFocalAnchor(
        el,
        positionsRef.current,
        colAssignmentRef.current,
        columnOffsetsRef.current,
        colsRef.current,
        focalBookmarkIdRef.current,
        itemsRef.current,
      );
      if (primary || perColumn.some((a) => a !== null)) {
        pendingAnchorsRef.current = { primary, perColumn };
      }

      // Resize is active. Mark unsettled so the boundary effect skips
      // the DOM batch this commit. Reschedule the settle timer; only
      // when the user stops resizing for 150 ms does the boundary
      // effect get to fire its expensive DOM measurement.
      setResizeSettled(false);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setResizeSettled(true);
      }, 150);

      lastW = w;
      setContainerWidth(w);
    };

    const ro = new ResizeObserver(() => {
      if (!el) return;
      pendingW = el.clientWidth;
      if (rafId) return;
      rafId = requestAnimationFrame(handle);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollEl = findScrollParent(el);

    function update() {
      if (!el) return;
      const containerTop = el.getBoundingClientRect().top;
      const scrollTop =
        scrollEl === document.documentElement
          ? 0
          : scrollEl.getBoundingClientRect().top;
      const height =
        scrollEl === document.documentElement
          ? window.innerHeight
          : scrollEl.clientHeight;
      setScrollY(scrollTop - containerTop);
      setViewportH(height);

      // Suppress focal refresh during active resize and inside the
      // brief window after a programmatic scrollTop write. The anchor
      // logic just placed the focal bookmark exactly where the user
      // expected; any scroll event firing here is the bubble from our
      // own write, not the user looking at a new bookmark. Without
      // this, multi-step resizes (4→3→2→3→4 across column-count
      // boundaries) would rebase focal at every step, accumulating
      // drift across the chain.
      //
      // Two guards stacked because the failure modes are different:
      // - resizeSettledRef catches the slow-drag case where RO ticks
      //   can be 200+ ms apart and the timestamp window lapses
      //   between them. False from first RO tick until 150 ms after
      //   the last.
      // - programmaticScrollUntilRef catches scroll-event bubbles
      //   from individual scrollTop writes (anchor commits, boundary
      //   correction reflows). 100 ms after each write.
      // See respective ref declarations for full rationale.
      if (!resizeSettledRef.current) return;
      if (performance.now() < programmaticScrollUntilRef.current) return;

      // Refresh focal anchor: which bookmark currently "owns" the
      // viewport top? Stable across resizes — RO reads this id rather
      // than re-snapshotting topmost-visible per RO tick. See
      // captureFocalAnchor for the why.
      const target =
        scrollEl === document.documentElement
          ? window.scrollY
          : scrollEl.scrollTop;
      const positions = positionsRef.current;
      const colAssignment = colAssignmentRef.current;
      const columnOffsets = columnOffsetsRef.current;
      const list = itemsRef.current;
      let nextFocalId: string | null = null;
      // First-pass: bookmark whose rendered range straddles the viewport
      // top. Falls back to the topmost bookmark visible below the
      // viewport top if no straddle (e.g., scrolled past everything in
      // a column due to a gap).
      let bestBelow = Infinity;
      let bestBelowIdx = -1;
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        const c = colAssignment[i];
        if (c === undefined) continue;
        const off = columnOffsets[c] ?? 0;
        const renderedTop = p.y + off;
        if (renderedTop <= target && renderedTop + p.h > target) {
          nextFocalId = list[i]?.id ?? null;
          break;
        }
        if (renderedTop > target && renderedTop < bestBelow) {
          bestBelow = renderedTop;
          bestBelowIdx = i;
        }
      }
      if (!nextFocalId && bestBelowIdx >= 0) {
        nextFocalId = list[bestBelowIdx]?.id ?? null;
      }
      if (nextFocalId) focalBookmarkIdRef.current = nextFocalId;
    }

    update();
    let frame = 0;
    let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
    // Track settled state in a closure variable so we only fire the React
    // setter on transitions (settled → moving, moving → settled). Calling
    // setState every scroll frame would defeat BookmarkCard's memo for the
    // settle prop. Same pattern as gallery-list.
    let isSettled = true;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
        if (isSettled) {
          isSettled = false;
          setScrollSettled(false);
        }
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        scrollSettleTimer = setTimeout(() => {
          scrollSettleTimer = null;
          isSettled = true;
          setScrollSettled(true);
        }, 150);
      });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
      if (frame) cancelAnimationFrame(frame);
      if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
    };
  }, []);

  // Sync resizeSettledRef with the state on every state change. Read
  // by the scroll handler's update() function (which closes over its
  // initial state via empty-deps useEffect); the ref is the only way
  // for that closure to see the current settle status.
  useLayoutEffect(() => {
    resizeSettledRef.current = resizeSettled;
  }, [resizeSettled]);

  const cols = useMemo(() => {
    if (containerWidth === 0) return 0;
    return Math.max(
      1,
      Math.floor((containerWidth + GAP) / (columnWidth + GAP)),
    );
  }, [containerWidth, columnWidth]);

  // Stable colAssignment — same as production BookmarkList: greedy
  // shortest-column on the SUM of canvas heights at multiple sample
  // widths. Independent of containerWidth-derived colW so resize
  // doesn't reshuffle items.
  const colAssignment = useMemo(() => {
    if (cols === 0) return [] as number[];
    const result = new Array<number>(items.length);
    const colHeights = new Array<number>(cols).fill(0);
    for (let i = 0; i < items.length; i++) {
      let refHeight = 0;
      for (const w of SAMPLE_WIDTHS) {
        refHeight += computeBookmarkHeightWithBoundary(items[i], w).height;
      }
      let shortest = 0;
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[shortest]) shortest = c;
      }
      result[i] = shortest;
      colHeights[shortest] += refHeight;
    }
    return result;
  }, [items, cols]);

  // Per-card override key. Buckets innerWidth to integer pixels —
  // matches the precision of layout decisions and avoids per-frame cache
  // misses when colW jitters by sub-pixels during a drag.
  const overrideKey = (bookmarkId: string, innerWidth: number): string =>
    `${bookmarkId}:${Math.round(innerWidth)}`;

  // Layout: heights from canvas, with DOM overrides applied where
  // available. Boundary candidates collected for the next render's
  // useLayoutEffect to resolve.
  const { positions, colHeights, boundaryQueue } = useMemo(() => {
    if (containerWidth === 0 || cols === 0) {
      return {
        positions: [] as Position[],
        colHeights: [] as number[],
        boundaryQueue: [] as Array<{
          bookmarkId: string;
          canvasTotal: number;
          innerWidth: number;
          sections: BoundaryTextSection[];
        }>,
      };
    }
    const colW = (containerWidth - (cols - 1) * GAP) / cols;
    const innerWidth = colW - 24; // INNER_CONTENT_INSET, kept inline
    const colHeights = new Array<number>(cols).fill(0);
    const next = new Array<Position>(items.length);
    const queue: Array<{
      bookmarkId: string;
      canvasTotal: number;
      innerWidth: number;
      sections: BoundaryTextSection[];
    }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = overrideKey(item.id, innerWidth);
      let h: number;
      if (heightOverrides.has(key)) {
        h = heightOverrides.get(key)!;
      } else {
        const r = computeBookmarkHeightWithBoundary(
          item,
          colW,
          BOUNDARY_THRESHOLD_PX,
        );
        h = r.height;
        if (r.boundaryRisk.length > 0) {
          queue.push({
            bookmarkId: item.id,
            canvasTotal: r.height,
            innerWidth,
            sections: r.boundaryRisk,
          });
        }
      }
      const col = colAssignment[i] ?? 0;
      const x = col * (colW + GAP);
      const y = colHeights[col];
      next[i] = { x, y, w: colW, h };
      colHeights[col] = y + h + GAP;
    }

    return { positions: next, colHeights, boundaryQueue: queue };
  }, [items, containerWidth, cols, colAssignment, heightOverrides]);

  const totalHeight = useMemo(() => {
    if (cols === 0 || colHeights.length === 0) return 0;
    let max = 0;
    for (let c = 0; c < cols; c++) {
      const h = (colHeights[c] ?? 0) + (columnOffsets[c] ?? 0);
      if (h > max) max = h;
    }
    return max;
  }, [colHeights, columnOffsets, cols]);

  // useLayoutEffect (not useEffect) so refs sync in the commit phase,
  // not after paint. The RO callback fires in the resize observer step
  // (after layout, before paint), so on rapid sequential resizes a
  // useEffect-based sync would still hold values from the render BEFORE
  // last — anchor capture would calibrate against a layout state two
  // commits old, producing the wild per-column drift seen in testing.
  // The boundary-resolution effect (idle-scheduled, fires after paint)
  // doesn't have the same urgency, but consistent commit-phase syncing
  // means every reader of these refs sees the latest committed values
  // regardless of which phase they run in.
  useLayoutEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  useLayoutEffect(() => {
    colAssignmentRef.current = colAssignment;
  }, [colAssignment]);
  useLayoutEffect(() => {
    columnOffsetsRef.current = columnOffsets;
  }, [columnOffsets]);
  useLayoutEffect(() => {
    colsRef.current = cols;
  }, [cols]);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useLayoutEffect(() => {
    if (columnOffsets.length !== cols) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing offsets length to cols on column-count change; gated above so it can't loop
      setColumnOffsets(new Array(cols).fill(0));
    }
  }, [cols, columnOffsets.length]);

  // DOM-fallback resolution. After positions render and the resize has
  // SETTLED (≥150 ms since last RO tick), batch-measure boundary cards
  // via real browser layout. Each candidate has one or more text
  // sections; the corrected total = canvas total + sum(domHeight -
  // canvasHeight) across sections that actually disagreed.
  //
  // Gated on `resizeSettled` so the DOM batch (which can stall paint by
  // ~100 ms+ on first encounter at a new colW) doesn't fire during an
  // active drag. Canvas-only heights drive the layout while the user is
  // dragging — matches production Home's feel. After settle, this
  // effect runs once, captures pre-correction anchors against the
  // currently-rendered (canvas-only) positions, then triggers the
  // correction. The existing per-column anchor effect (deps:
  // [positions, cols]) re-runs on the corrected render, sees the fresh
  // pendingAnchorsRef, and applies offsets so visible content stays
  // put across the correction.
  //
  // Scheduled via requestIdleCallback (not synchronous useLayoutEffect)
  // so the DOM batch — ~70-100 ms of layout work for ~100 boundary
  // candidates at a fresh colW — doesn't block the next paint after
  // settle. With sync layout effect, the user's settle-tail experience
  // included a frozen frame of that duration. Idle scheduling lets the
  // browser paint each frame normally; the DOM batch slots into idle
  // time and corrections land 1–2 frames later with no jank. Cost: a
  // brief flash of canvas-only positions before corrections apply on
  // first encounter at any new colW. The flash is bounded by ~20 px
  // shifts on the few cards with boundary cases — strictly smaller
  // than the paint stall it replaces.
  useEffect(() => {
    if (boundaryQueue.length === 0) return;
    if (!resizeSettled) return;

    // requestIdleCallback isn't in Safari's stable shipping form yet
    // (still flagged behind a setting). Fall back to a 0 ms setTimeout
    // — schedules after current commit finishes, doesn't block paint
    // for the same reason. timeout: 500 forces idle callback to fire
    // even if browser stays busy, so corrections don't sit forever.
    const hasIdle =
      typeof window !== "undefined" &&
      typeof window.requestIdleCallback === "function";
    const schedule = (cb: () => void): number =>
      hasIdle
        ? window.requestIdleCallback(cb, { timeout: 500 })
        : window.setTimeout(cb, 0);
    const cancel = (handle: number): void => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };

    const handle = schedule(
      () => {
        // Build the DOM-measure batch.
        const batchItems: { key: string; text: string; innerWidth: number }[] = [];
        for (const entry of boundaryQueue) {
          for (let i = 0; i < entry.sections.length; i++) {
            const s = entry.sections[i];
            batchItems.push({
              key: `${entry.bookmarkId}:${s.kind}:${i}:${Math.round(s.innerWidth)}`,
              text: s.text,
              innerWidth: s.innerWidth,
            });
          }
        }
        if (batchItems.length === 0) return;

        const measured = batchMeasureTextHeights(batchItems);

        const corrections = new Map<string, number>();
        let anyDiff = false;
        for (const entry of boundaryQueue) {
          let diff = 0;
          for (let i = 0; i < entry.sections.length; i++) {
            const s = entry.sections[i];
            const k = `${entry.bookmarkId}:${s.kind}:${i}:${Math.round(s.innerWidth)}`;
            const dom = measured.get(k);
            if (dom === undefined) continue;
            diff += dom - s.canvasHeight;
          }
          if (diff !== 0) anyDiff = true;
          // Always store, even when diff === 0 — marks the (bookmark, colW)
          // pair as resolved so it doesn't re-queue on every render.
          corrections.set(
            overrideKey(entry.bookmarkId, entry.innerWidth),
            entry.canvasTotal + diff,
          );
        }

        if (corrections.size === 0) return;

        // Only when corrections actually shift positions, capture per-
        // column anchors against the *current* (canvas-only) rendered
        // geometry BEFORE updating heightOverrides. The existing anchor
        // effect's [positions, cols] dep will re-fire after the correction
        // render and consume these anchors, applying offsets to keep
        // visible content in place across the correction. When diff is 0,
        // the corrections are no-ops and the anchor effect doesn't need
        // to run again.
        if (anyDiff) {
          const el = containerRef.current;
          if (el) {
            const perColumn = capturePerColumnAnchors(
              el,
              positionsRef.current,
              colAssignmentRef.current,
              columnOffsetsRef.current,
              colsRef.current,
            );
            const primary = captureFocalAnchor(
              el,
              positionsRef.current,
              colAssignmentRef.current,
              columnOffsetsRef.current,
              colsRef.current,
              focalBookmarkIdRef.current,
              itemsRef.current,
            );
            if (primary || perColumn.some((a) => a !== null)) {
              pendingAnchorsRef.current = { primary, perColumn };
            }
          }
        }

        setHeightOverrides((prev) => {
          const next = new Map(prev);
          for (const [k, v] of corrections) next.set(k, v);
          return next;
        });
      },
    );
    return () => cancel(handle);
  }, [boundaryQueue, resizeSettled]);

  /* eslint-disable react-hooks/refs --
   * Pre-commit DOM read for prop-driven layout changes; same pattern
   * as the production BookmarkList.
   */
  const prevColumnWidthRef = useRef(columnWidth);
  if (prevColumnWidthRef.current !== columnWidth) {
    const el = containerRef.current;
    if (el) {
      const perColumn = capturePerColumnAnchors(
        el,
        positionsRef.current,
        colAssignmentRef.current,
        columnOffsetsRef.current,
        colsRef.current,
      );
      const primary = captureFocalAnchor(
        el,
        positionsRef.current,
        colAssignmentRef.current,
        columnOffsetsRef.current,
        colsRef.current,
        focalBookmarkIdRef.current,
        itemsRef.current,
      );
      if (primary || perColumn.some((a) => a !== null)) {
        pendingAnchorsRef.current = { primary, perColumn };
      }
    }
    prevColumnWidthRef.current = columnWidth;
  }
  /* eslint-enable react-hooks/refs */

  useLayoutEffect(() => {
    const pending = pendingAnchorsRef.current;
    if (!pending) return;
    pendingAnchorsRef.current = null;

    // Primary drives scrollTop. Prefer the focal-derived anchor (stable
    // across resizes — see captureFocalAnchor); fall back to the first
    // non-null per-column anchor if focal isn't available (no scroll yet,
    // focal bookmark filtered out).
    let primary: ColumnAnchor | null = pending.primary;
    if (!primary) {
      for (let c = 0; c < pending.perColumn.length; c++) {
        if (pending.perColumn[c]) {
          primary = pending.perColumn[c];
          break;
        }
      }
    }
    if (!primary) return;

    const newPrimaryPos = positions[primary.itemIndex];
    if (!newPrimaryPos) return;

    const el = containerRef.current;
    if (!el) return;
    const scrollEl = findScrollParent(el);

    let newScrollTop =
      newPrimaryPos.y - (primary.oldRenderedY - primary.oldScrollTop);

    const newOffsets = new Array<number>(cols).fill(0);

    if (pending.perColumn.length === cols) {
      for (let c = 0; c < cols; c++) {
        const a = pending.perColumn[c];
        if (!a) continue;
        const np = positions[a.itemIndex];
        if (!np) continue;
        const oldScreenY = a.oldRenderedY - a.oldScrollTop;
        newOffsets[c] = oldScreenY + newScrollTop - np.y;
      }

      let minOffset = 0;
      for (let c = 0; c < cols; c++) {
        if (newOffsets[c] < minOffset) minOffset = newOffsets[c];
      }
      if (minOffset < 0) {
        for (let c = 0; c < cols; c++) newOffsets[c] -= minOffset;
        newScrollTop -= minOffset;
      }
    }

    // Mark the next ~100 ms of scroll events as programmatic so the
    // scroll handler's focal-refresh block skips them. See
    // programmaticScrollUntilRef declaration.
    programmaticScrollUntilRef.current = performance.now() + 100;
    if (scrollEl === document.documentElement) {
      window.scrollTo(0, newScrollTop);
    } else {
      scrollEl.scrollTop = newScrollTop;
    }
    setColumnOffsets(newOffsets);

    const containerTop = el.getBoundingClientRect().top;
    const scrollElTop =
      scrollEl === document.documentElement
        ? 0
        : scrollEl.getBoundingClientRect().top;
    setScrollY(scrollElTop - containerTop);
  }, [positions, cols]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollEl = findScrollParent(el);
    const containerTop = el.getBoundingClientRect().top;
    const scrollElTop =
      scrollEl === document.documentElement
        ? 0
        : scrollEl.getBoundingClientRect().top;
    setScrollY(scrollElTop - containerTop);
  }, [totalHeight]);

  useLayoutEffect(() => {
    if (scrollY > SNAP_RESET_THRESHOLD) return;
    if (
      columnOffsets.length === cols &&
      columnOffsets.every((v) => v === 0)
    ) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snap reset to zero offsets when scrolled to top; gated by length match + all-zero check above so it can't loop
    setColumnOffsets(new Array(cols).fill(0));
  }, [scrollY, cols, columnOffsets]);

  const viewTop = scrollY - OVERSCAN_PX;
  const viewBottom = scrollY + viewportH + OVERSCAN_PX;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: totalHeight ? `${totalHeight}px` : undefined,
      }}
    >
      {items.map((item, i) => {
        const pos = positions[i];
        if (!pos) return null;
        const col = colAssignment[i] ?? 0;
        const offset = columnOffsets[col] ?? 0;
        const renderedY = pos.y + offset;
        if (renderedY + pos.h <= viewTop || renderedY >= viewBottom) {
          return null;
        }
        // Viewport proper (no overscan) — feeds CardVideo's mount strategy.
        const isInViewport =
          renderedY + pos.h > scrollY && renderedY < scrollY + viewportH;
        return (
          <div
            key={item.id}
            style={{
              position: "absolute",
              top: `${renderedY}px`,
              left: `${pos.x}px`,
              width: `${pos.w}px`,
            }}
          >
            <BookmarkCard
              bookmark={item}
              scrollSettled={scrollSettled}
              isInViewport={isInViewport}
            />
          </div>
        );
      })}
    </div>
  );
}
