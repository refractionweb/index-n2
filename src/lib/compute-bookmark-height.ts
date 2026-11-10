// SPIKE: candidate height-computation function for the home/archive
// virtualization rewrite. Goal of the calibration tab is to validate that
// this function's output matches `BookmarkCard`'s actual `offsetHeight`
// within ~15 px (95th percentile) across a representative sample.
//
// Constants below are best-guess estimates from inspecting BookmarkCard's
// CSS. The calibration spike's job is to reveal where they're wrong;
// once we have measurements we tune them, then the function is the basis
// for the real implementation. Delete this file (or keep + promote it)
// after the spike commits one way or the other.
//
// Per-bookmark text cache: each bookmark's body text and (if present) its
// quoted-tweet text get tokenized + measured once and stashed in a WeakMap
// keyed by the bookmark/quote reference. Wrap layout at any colW becomes
// pure arithmetic over the cached token widths — no `measureText` calls in
// the hot path. Word widths don't depend on column width, so a resize
// (drag, sidebar toggle, zoom) only re-runs the wrap loop, not the
// measurement. The break-words case (single token wider than the line)
// still falls back to `measureText` for character-level breaking, but
// that's rare and per-line, not per-token-per-colW.

import type { Bookmark, MediaItem, QuotedTweet } from "@/types/bookmark";
import {
  ARTICLE_PENDING_PREFIX,
  ARTICLE_PENDING_CODE,
  ARTICLE_PENDING_SUFFIX,
} from "@/components/article-block";
import {
  expandTcoLinks,
  shortenUrlForDisplay,
  splitUrlTail,
  URL_PATTERN,
} from "./format";
import { extractReplyHandles } from "./reply-handles";

const TEXT_LIMIT = 280;

// Structural constants — best guesses from inspecting BookmarkCard's CSS.
// Tune based on calibration results.
const PADDING_VERTICAL = 24; // p-3 on the inner div (12 + 12)
const GAP = 12; // gap-3 between sections inside the inner div
const HEADER_HEIGHT = 40; // AuthorLink size="sm" + checkbox row
const TEXT_LINE_HEIGHT = 20; // text-sm line-height (1.25rem at 16px root)

// ReplyOrThreadPills: Badges in a `flex flex-wrap gap-1` row. A reply with
// several handles wraps onto more rows, so the row count is computed from
// each pill's width (see pillsHeight). Badge geometry (ui/badge.tsx):
// h-5, 1 px border, px-2, text-[0.625rem] font-medium, and an icon at
// size-2.5 + gap-1 on the lead pill.
const PILL_ROW_HEIGHT = 20; // h-5
const PILL_GAP = 4; // gap-1, both axes
const PILL_CHROME = 2 + 16; // border 1+1, px-2 8+8
const PILL_ICON = 10 + 4; // [&>svg]:size-2.5 + gap-1
const PILL_FONT = "500 10px 'Inter Variable', sans-serif";
// Must match the thread pill's label in reply-pills.tsx.
const THREAD_PILL_LABEL = "Thread";
const TRUNCATE_INDICATOR_HEIGHT = 24; // "Open full post" line + mt-1 internal spacing
const DATE_FOOTER_BLOCK = 40; // date <a> + gap-1 + footer row (rough)

// CardMedia grid: `auto-rows-[180px] grid-cols-2 gap-0.5`. Single image
// is solo (no grid). 2 images = 1 row × 180. 3-4 images = 2 rows × 180
// + 1 row gap (gap-0.5 = 2 px).
const MEDIA_ROW_HEIGHT = 180;
const MEDIA_ROW_GAP = 2;

// QuotedTweetCard structural pieces. The outer <button> is block flow
// (not flex), so vertical margins between siblings COLLAPSE — that's why
// avatar and media are tracked as separate constants instead of one
// combined "header block": it lets us honor `max(mb-1, mt-1.5)` when no
// text sits between them.
const QUOTE_BORDER = 2; // 1px each side
const QUOTE_PADDING_VERTICAL = 16; // p-2 (8 + 8)
const QUOTE_PADDING_HORIZONTAL = 16; // p-2 (8 + 8)
const QUOTE_HEADER_AVATAR = 16; // size-4
const QUOTE_HEADER_MB = 4; // mb-1
const QUOTE_MEDIA_MT = 6; // mt-1.5
const QUOTE_MAX_SOLO_MEDIA_HEIGHT = 192; // max-h-48

// Orphan-quote placeholder card. Single line of `text-sm` (20 px) inside
// `border + p-2`, no header, no media. 2 + 16 + 20 = 38. Fixed regardless
// of column width — "This post is unavailable." fits any column we render
// at. Keep in sync with QuotedTweetCard's null-quote branch (the outer
// shell uses QUOTE_CARD_OUTER over there).
const MISSING_QUOTE_HEIGHT = 38;

// Article preview block (rendered when bookmark.article is set; see
// article-block.tsx). Layout: shadcn Badge pill → title (text-base
// font-semibold leading-tight, free wrap) → body (text-sm regular,
// line-clamp-3, browser ellipsis). Outer is `rounded-md border p-2`
// (1 px border each side, 8 px padding each side).
//
// Body height is constant because every X Article body in the corpus
// is far longer than 3 lines fit (min 2,216 chars vs ~120-char/3-line
// capacity at typical card width) — line-clamp-3 always hits the cap.
// If the filter is ever broadened to shorter article-shaped enrichment,
// this constant assumption needs to become min(actual, 3) * line height.
const ARTICLE_BORDER = 2;
const ARTICLE_PADDING_VERTICAL = 16; // p-2 (8 + 8)
const ARTICLE_PADDING_HORIZONTAL = 16; // p-2 (8 + 8)
const ARTICLE_PILL_HEIGHT = 20; // Badge h-5
const ARTICLE_PILL_MB = 8; // mb-2 between pill and title
const ARTICLE_TITLE_GAP = 8; // mt-2 between title and body
const ARTICLE_BODY_LINES = 3; // line-clamp-3
const ARTICLE_BODY_HEIGHT = ARTICLE_BODY_LINES * TEXT_LINE_HEIGHT; // 60
// text-base (16 px) leading-tight (1.25) → 20 px line height,
// coincidentally equal to TEXT_LINE_HEIGHT. Canvas measureText is
// font-weight-sensitive — semibold is wider than regular — so title
// tokenization must use this font.
const ARTICLE_TITLE_FONT = '600 16px "Inter Variable", sans-serif';

// Pending-state CopyableCode (`font-mono px-1`) renders the command in a
// monospace face with 4 px horizontal padding each side. Treat as a
// single non-breaking token so the wrap loop preserves it as one unit;
// width = monospace measurement + padding.
const ARTICLE_PENDING_CODE_FONT = '14px ui-monospace, monospace';
const ARTICLE_PENDING_CODE_PADDING = 8; // px-1 × 2 sides

// Inner content width (text wrap target) = colW minus the inner div's
// horizontal padding.
const INNER_CONTENT_INSET = 24;

// Body text font matches BookmarkCard's <p className="text-sm">.
// Tailwind v4 default text-sm: 14px. Font: var(--font-sans) →
// 'Inter Variable', sans-serif. Weight: normal (400).
const FONT = "14px 'Inter Variable', sans-serif";

// Subpixel slack between canvas measureText and the browser's actual
// text layout. Canvas reports float widths but the browser's layout
// engine uses subpixel positioning + kerning + font features that don't
// perfectly mirror canvas output — at line-break boundaries the two
// disagree by 0.5–3 px on whether a candidate fits. Without tolerance,
// canvas wraps a line one word earlier than the browser does, causing
// our predicted height to be one TEXT_LINE_HEIGHT taller than the
// actual rendered card → visible gap below the card in the layout.
//
// Bias direction: tolerance widens the "fits" check, making canvas more
// permissive (closer to how browsers actually wrap). Net effect on
// prediction: fewer over-counts → fewer gaps. Risk: if pushed too high,
// would start under-counting → cards rendered taller than predicted →
// visible overlap with the next card. Calibration confirms 1 is safe;
// don't go above 2 without re-running calibration.
const WRAP_TOLERANCE = 1;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (ctx) return ctx;
  canvas = document.createElement("canvas");
  ctx = canvas.getContext("2d");
  if (ctx) ctx.font = FONT;
  return ctx;
}

// Canvas measureText doesn't wait for web fonts: if Inter's face for a
// character range hasn't loaded, it silently measures the fallback font,
// and the per-bookmark caches below keep that width for the session. The
// @fontsource faces are split by unicode-range and a face only loads once
// text using it renders, so Cyrillic / Greek / Latin-ext glyphs are
// usually still unloaded when the list first measures. Await this before
// handing bookmarks to the list. Times out rather than holding the list
// back if a font request stalls.
const MEASURE_FONTS = [FONT, PILL_FONT, ARTICLE_TITLE_FONT];
const FONT_LOAD_TIMEOUT_MS = 3000;

export async function loadMeasureFonts(bookmarks: Bookmark[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const chars = new Set<string>();
  const add = (s: string | undefined | null) => {
    if (s) for (const ch of s) chars.add(ch);
  };
  for (const b of bookmarks) {
    add(b.text);
    add(b.quotedTweet?.text);
    add(b.article?.title);
  }
  const sample = [...chars].join("");
  const pending = MEASURE_FONTS.filter((f) => !document.fonts.check(f, sample));
  if (pending.length === 0) return;
  await Promise.race([
    Promise.all(pending.map((f) => document.fonts.load(f, sample))).catch(
      () => undefined,
    ),
    new Promise((resolve) => setTimeout(resolve, FONT_LOAD_TIMEOUT_MS)),
  ]);
}

// One token = one whitespace-separated chunk of text. `width` is measured
// once at tokenization time and reused for any colW. Caching at this
// granularity is the architectural insight: line wrap is "sum widths until
// exceeding colW," which is pure arithmetic over precomputed values.
type Token = {
  text: string;
  width: number;
};

// Per-bookmark text data: derived once (text pipeline + tokenization +
// per-word measurement) and reused for every colW. Cache key is the
// bookmark/quote reference; when sync replaces the bookmarks array, old
// entries get GC'd via WeakMap.
type BodyTextData = {
  displayText: string;
  truncated: boolean;
  hasPills: boolean;
  // Outer width of each reply/thread pill, in render order. Empty when
  // there are no pills.
  pillWidths: number[];
  paragraphs: Token[][];
};

type QuoteTextData = {
  displayText: string;
  hasText: boolean;
  hasMedia: boolean;
  paragraphs: Token[][];
};

// Article title is tokenized at ARTICLE_TITLE_FONT (semibold 16 px); body
// excerpt is constant height (line-clamp-3 always saturated for X
// Articles), so only the title needs cached tokens.
type ArticleTitleData = {
  paragraphs: Token[][];
};

const bodyDataCache = new WeakMap<Bookmark, BodyTextData>();
const quoteDataCache = new WeakMap<QuotedTweet, QuoteTextData>();
const articleTitleCache = new WeakMap<Bookmark, ArticleTitleData>();

// Tokenize text into paragraphs of measured tokens. Splits on `\n` first
// (matches `whitespace-pre-wrap` paragraph boundaries), then on
// whitespace/word boundaries within each paragraph. Whitespace tokens
// kept alongside word tokens to mirror real browser wrap: trailing space
// at line end takes width, leading whitespace on a wrapped line is
// collapsed (handled by the wrap loop, not here).
function tokenize(
  text: string,
  c: CanvasRenderingContext2D,
  font: string = FONT,
): Token[][] {
  c.font = font;
  return text.split("\n").map((para) => {
    if (para === "") return [];
    const matches = para.match(/\S+|\s+/g) ?? [];
    return matches.map((t) => ({ text: t, width: c.measureText(t).width }));
  });
}

// Apply linkifyText's per-URL display rule across a whole string. linkify
// splits text into tokens and shortens each URL token; here we measure an
// unsplit string, so we find URLs with the same pattern and shorten each via
// the shared shortenUrlForDisplay — the renderer and predictor now use ONE
// definition of the rule, not two mirrored copies. Without this, the
// predictor measures expanded URL strings 3–4× wider than rendered, producing
// visible gaps below cards with long URLs.
const URL_GLOBAL = new RegExp(URL_PATTERN.source, "g");
function shortenUrlsForDisplay(text: string): string {
  return text.replace(URL_GLOBAL, (match) => {
    const [url, tail] = splitUrlTail(match);
    return shortenUrlForDisplay(url) + tail;
  });
}

function getBodyData(bookmark: Bookmark): BodyTextData {
  const cached = bodyDataCache.get(bookmark);
  if (cached) return cached;

  const expandedText = expandTcoLinks(bookmark.text || "", bookmark.links);
  const { handles, rest } = extractReplyHandles(expandedText);
  const truncated = rest.length > TEXT_LIMIT;
  // Apply URL shortening AFTER the 280-char truncate to match the
  // renderer's order (bookmark-card.tsx → linkifyText). The truncate
  // check operates on the expanded text length so the `truncated` flag
  // (and the "Open full post" indicator it gates) fires consistently with
  // the renderer; URL display shortening then runs over whatever text
  // survives the truncate, mirroring linkifyText's behavior exactly.
  const baseDisplayText = truncated ? rest.slice(0, TEXT_LIMIT) + "…" : rest;
  const displayText = shortenUrlsForDisplay(baseDisplayText);
  const hasPills = handles.length > 0 || bookmark.isThread;

  const c = getCtx();
  const pillWidths = hasPills && c ? measurePills(handles, c) : [];
  const paragraphs = displayText && c ? tokenize(displayText, c) : [];

  const data: BodyTextData = {
    displayText,
    truncated,
    hasPills,
    pillWidths,
    paragraphs,
  };
  bodyDataCache.set(bookmark, data);
  return data;
}

// Pill widths in ReplyOrThreadPills' render order: one pill per reply
// handle ("@name", icon on the first); with no handles, a single thread
// pill. Callers only invoke this when the card shows pills.
function measurePills(
  handles: string[],
  c: CanvasRenderingContext2D,
): number[] {
  c.font = PILL_FONT;
  const labels = handles.length > 0 ? handles.map((h) => `@${h}`) : [THREAD_PILL_LABEL];
  return labels.map(
    (label, i) =>
      PILL_CHROME + (i === 0 ? PILL_ICON : 0) + c.measureText(label).width,
  );
}

// Height of the wrapped pill row. Flex-wrap moves a pill to a new row when
// it doesn't fit after the previous one plus the gap.
function pillsHeight(pillWidths: number[], innerWidth: number): number {
  if (pillWidths.length === 0) return 0;
  let rows = 1;
  let x = 0;
  for (const w of pillWidths) {
    if (x === 0) {
      x = w;
    } else if (x + PILL_GAP + w > innerWidth) {
      rows += 1;
      x = w;
    } else {
      x += PILL_GAP + w;
    }
  }
  return rows * PILL_ROW_HEIGHT + (rows - 1) * PILL_GAP;
}

function getQuoteData(quote: QuotedTweet): QuoteTextData {
  const cached = quoteDataCache.get(quote);
  if (cached) return cached;

  const text = quote.text || "";
  const truncated = text.length > TEXT_LIMIT;
  // Truncate THEN shorten URLs, mirroring the renderer
  // (quoted-tweet-card.tsx → linkifyText) and the body path in getBodyData.
  // Quoted tweets have no `links` field so nothing expands, but linkify still
  // strips protocols / truncates long URLs — measuring the raw URL over-counts
  // line width and leaves a gap under the quoted card.
  const baseDisplayText = truncated ? text.slice(0, TEXT_LIMIT) + "…" : text;
  const displayText = shortenUrlsForDisplay(baseDisplayText);
  const hasText = !!displayText;
  const hasMedia = !!(quote.media && quote.media.length > 0);

  const c = getCtx();
  const paragraphs = displayText && c ? tokenize(displayText, c) : [];

  const data: QuoteTextData = { displayText, hasText, hasMedia, paragraphs };
  quoteDataCache.set(quote, data);
  return data;
}

// Greedy line-wrap consuming pre-measured tokens. Same algorithm as the
// previous `measureText`-driven version, but the per-token widths are
// already cached — `lineWidth + tok.width` replaces what used to be
// `ctx.measureText(line + tok)`. measureText is still called for the
// break-words fallback when a single token exceeds the line, since that
// requires character-level slicing.
//
// Inline `<a>`/`<mark>` spans inside linkifyText output don't change wrap
// behavior — wrap is determined by text-node content, not tag boundaries
// — so measuring the joined plain-text string is equivalent to measuring
// the rendered linkified content. This holds only while those spans add
// no inline width: the search highlight's px-px is cancelled by -mx-px
// for that reason (highlight.tsx).
//
// Subpixel note: sum of per-token widths ≈ measureText(concatenation) for
// Latin text in Inter Variable, but float arithmetic and rare cross-word
// kerning can shift the sum by <1 px from the per-string measurement.
// Should be invisible at the line-count granularity (line-break decisions
// happen at integer-pixel-ish boundaries); the calibration spike confirms.
function wrapTokens(
  paragraphs: Token[][],
  innerWidth: number,
  boundaryThresholdPx?: number,
  font: string = FONT,
): { height: number; lines: number; hasBoundaryRisk: boolean } {
  if (paragraphs.length === 0)
    return { height: 0, lines: 0, hasBoundaryRisk: false };
  const c = getCtx();
  if (!c) return { height: 0, lines: 0, hasBoundaryRisk: false };
  c.font = font;

  // Boundary risk = canvas wrap decision is fragile: the line width is
  // close enough to innerWidth that a 1-2 px disagreement between canvas
  // and browser layout could flip canvas's "fits / wraps" decision. The
  // DOM-fallback test tab uses this signal to selectively re-measure
  // such cards via real browser layout. When `boundaryThresholdPx` is
  // not provided (production callers), the flag stays false — the check
  // is skipped entirely.
  const checkBoundary = boundaryThresholdPx !== undefined;
  const threshold = boundaryThresholdPx ?? 0;
  let hasBoundaryRisk = false;

  let totalLines = 0;
  for (const tokens of paragraphs) {
    if (tokens.length === 0) {
      totalLines += 1;
      continue;
    }

    let lineCount = 0;
    let lineText = "";
    let lineWidth = 0;

    for (const tok of tokens) {
      const isWhitespace = /^\s+$/.test(tok.text);
      const candidateWidth = lineWidth + tok.width;

      // Boundary check: if adding this token would land the line near
      // the wrap boundary, mark the paragraph as risky regardless of
      // the actual decision.
      if (
        checkBoundary &&
        !isWhitespace &&
        Math.abs(candidateWidth - innerWidth) < threshold
      ) {
        hasBoundaryRisk = true;
      }

      if (
        candidateWidth > innerWidth + WRAP_TOLERANCE &&
        lineText.length > 0
      ) {
        lineCount += 1;
        // Skip leading whitespace on the new line (browser collapses it).
        if (isWhitespace) {
          lineText = "";
          lineWidth = 0;
        } else {
          lineText = tok.text;
          lineWidth = tok.width;
        }
      } else {
        lineText += tok.text;
        lineWidth = candidateWidth;
      }

      // Break-words fallback: a single token wider than the line breaks at
      // character boundaries. Rare (long URLs, undelimited code dumps) so
      // a measureText fallback is acceptable. Tolerance applied here too
      // for consistency — character-level breaking should match the same
      // browser-permissive wrap behavior as token-level.
      while (
        lineWidth > innerWidth + WRAP_TOLERANCE &&
        lineText.length > 1
      ) {
        const cut = longestFittingPrefix(lineText, c, innerWidth);
        lineCount += 1;
        lineText = lineText.slice(cut);
        lineWidth = c.measureText(lineText).width;
      }
    }
    if (lineText.length > 0) lineCount += 1;
    totalLines += Math.max(1, lineCount);
  }

  return {
    height: totalLines * TEXT_LINE_HEIGHT,
    lines: totalLines,
    hasBoundaryRisk,
  };
}

function longestFittingPrefix(
  s: string,
  c: CanvasRenderingContext2D,
  innerWidth: number,
): number {
  let lo = 1;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(s.slice(0, mid)).width > innerWidth + WRAP_TOLERANCE) {
      hi = mid - 1;
    } else {
      lo = mid;
    }
  }
  return lo;
}

// Public: measure text height for a raw string. No bookmark to cache
// against, so tokenization happens per call. Used by external callers
// without a Bookmark reference; the internal `compute*` functions go
// through `getBodyData` / `getQuoteData` for the cached path.
export function measureTextHeight(text: string, innerWidth: number): number {
  const c = getCtx();
  if (!c) return 0;
  const paragraphs = tokenize(text, c);
  return wrapTokens(paragraphs, innerWidth).height;
}

// Media grid heights from CardMedia's `auto-rows-[180px] grid-cols-2 gap-0.5`:
// n=1 → solo, computed from aspect ratio (no grid).
// n=2 → 1 row × 180.
// n=3 → 2 rows (first item spans 2) + 1 row gap = 360 + 2.
// n=4 → 2 rows × 180 + 1 row gap = 360 + 2.
function computeMediaHeight(media: MediaItem[], colW: number): number {
  const count = media.length;
  if (count === 0) return 0;
  const inner = colW - INNER_CONTENT_INSET;
  if (count === 1) {
    const m = media[0];
    if (m.width && m.height) {
      return Math.round(inner * (m.height / m.width));
    }
    return 200; // fallback for missing aspect data
  }
  if (count === 2) return MEDIA_ROW_HEIGHT;
  return MEDIA_ROW_HEIGHT * 2 + MEDIA_ROW_GAP; // 3 or 4
}

// Quoted-tweet height. QuotedTweetCard renders:
// - <button> with `border p-2` (1px border each side, 8px padding each side).
//   Block flow — vertical margins between siblings COLLAPSE.
// - Header div: `mb-1` (4px), `text-xs` line (16px) with size-4 avatar
// - Optional <p className="text-sm break-words whitespace-pre-wrap"> with
//   text truncated to 280 chars (since truncate=true is passed by BookmarkCard)
// - Optional media: 1 image is `mt-1.5 max-h-48` aspect-ratio image,
//   2-4 images is `mt-1.5 flex gap-1` of square thumbnails.
//
// Margin collapse cases (block flow, padding stops collapse with parent):
//   header → text:   max(mb-1=4, p.mt=0) = 4
//   text   → media:  max(p.mb=0, mt-1.5=6) = 6
//   header → media (no text): max(mb-1=4, mt-1.5=6) = 6  ← critical case
//
// Width math: parent BookmarkCard's content area = colW - 24 (its p-3).
// QuotedTweetCard is `block w-full`, so its outer width = parent's content
// width = colW - 24. Its inner content area = outer - 2 (border) - 16 (p-2)
// = colW - 42.
type QuotedHeightResult = {
  height: number;
  textLines: number;
};
function computeQuotedHeightDetailed(
  quote: QuotedTweet,
  colW: number,
): QuotedHeightResult {
  const data = getQuoteData(quote);
  const outerWidth = colW - INNER_CONTENT_INSET; // colW - 24
  const innerWidth = outerWidth - QUOTE_BORDER - QUOTE_PADDING_HORIZONTAL; // - 2 - 16

  let h =
    QUOTE_BORDER + // 1px top + 1px bottom
    QUOTE_PADDING_VERTICAL + // p-2 top + p-2 bottom = 16
    QUOTE_HEADER_AVATAR; // size-4 = 16

  let textLines = 0;
  if (data.hasText) {
    h += QUOTE_HEADER_MB; // collapse: max(mb-1, p.mt=0) = 4
    const r = wrapTokens(data.paragraphs, innerWidth);
    h += r.height;
    textLines = r.lines;
  }

  if (data.hasMedia) {
    // Gap before media depends on what came before:
    // - text present:     collapse(p.mb=0, mt-1.5) = 6
    // - text absent:      collapse(header.mb=4, mt-1.5) = 6
    // Both happen to be 6, but spelled out for clarity.
    h += data.hasText
      ? QUOTE_MEDIA_MT
      : Math.max(QUOTE_HEADER_MB, QUOTE_MEDIA_MT);

    if (quote.media.length === 1) {
      const m = quote.media[0];
      if (m.width && m.height) {
        const aspectHeight = Math.round(innerWidth * (m.height / m.width));
        h += Math.min(QUOTE_MAX_SOLO_MEDIA_HEIGHT, aspectHeight);
      } else {
        h += QUOTE_MAX_SOLO_MEDIA_HEIGHT;
      }
    } else {
      const count = Math.min(4, quote.media.length);
      const gapTotal = (count - 1) * 4; // gap-1 = 4px
      const itemSize = (innerWidth - gapTotal) / count;
      h += itemSize; // square: height === width
    }
  }

  // Empty-quote case: header is always rendered with `mb-1` in the
  // markup. When a sibling exists after it (text or media), that 4 px is
  // already counted as the gap above (collapse with the next element's
  // mt). When there's no sibling, the 4 px still contributes to the
  // parent's content height — margin-bottom doesn't collapse with the
  // parent's padding-bottom, so the 4 px sits between the header content
  // and the parent's bottom padding. Without this, an empty quote (no
  // text, no media) under-counts by 4 px.
  if (!data.hasText && !data.hasMedia) {
    h += QUOTE_HEADER_MB;
  }

  return { height: h, textLines };
}

function computeQuotedHeight(quote: QuotedTweet, colW: number): number {
  return computeQuotedHeightDetailed(quote, colW).height;
}

function getArticleTitleData(bookmark: Bookmark): ArticleTitleData | null {
  if (!bookmark.article) return null;
  const cached = articleTitleCache.get(bookmark);
  if (cached) return cached;
  const c = getCtx();
  if (!c) return null;
  const paragraphs = tokenize(bookmark.article.title, c, ARTICLE_TITLE_FONT);
  const data: ArticleTitleData = { paragraphs };
  articleTitleCache.set(bookmark, data);
  return data;
}

// Article block height: pill + title (variable wrap at ARTICLE_TITLE_FONT)
// + gap + body (constant 3-line clamp). Width math mirrors
// QuotedTweetCard's: outer width = colW - INNER_CONTENT_INSET, inner
// content width = outer - border - horizontal padding. Boundary detection
// is intentionally skipped for the title — the DOM-fallback helper is
// hardcoded to text-sm, and titles are short enough that canvas alone is
// adequate.
function computeArticleBlockHeight(bookmark: Bookmark, colW: number): number {
  if (!bookmark.article) return 0;
  const titleData = getArticleTitleData(bookmark);
  if (!titleData) return 0;
  const articleInnerWidth =
    colW - INNER_CONTENT_INSET - ARTICLE_BORDER - ARTICLE_PADDING_HORIZONTAL;
  const titleResult = wrapTokens(
    titleData.paragraphs,
    articleInnerWidth,
    undefined,
    ARTICLE_TITLE_FONT,
  );
  return (
    ARTICLE_BORDER +
    ARTICLE_PADDING_VERTICAL +
    ARTICLE_PILL_HEIGHT +
    ARTICLE_PILL_MB +
    titleResult.height +
    ARTICLE_TITLE_GAP +
    ARTICLE_BODY_HEIGHT
  );
}

// Pending placeholder block: pill + single message paragraph. The
// message is split into prefix / code / suffix because the inline
// CopyableCode renders in monospace with 8 px of horizontal padding —
// measuring the whole string at FONT (Inter) would under-count the
// code's rendered width by ~30 px and flip wrap decisions at narrow
// widths. Tokens are cached at module scope (the message is shared
// across every placeholder render). Wrap result depends on innerWidth,
// so we recompute that part per call.
let placeholderTokens: Token[][] | null = null;
function getPlaceholderTokens(): Token[][] {
  if (placeholderTokens) return placeholderTokens;
  const c = getCtx();
  if (!c) return [];
  // Prefix and suffix at FONT (text-sm Inter regular).
  const prefixTokens = tokenize(ARTICLE_PENDING_PREFIX, c, FONT);
  const suffixTokens = tokenize(ARTICLE_PENDING_SUFFIX, c, FONT);
  // Code as a single non-breaking token, measured at the monospace font
  // plus the CopyableCode button's horizontal padding. Wrap loop treats
  // this as one indivisible word — matches reality (the button can't
  // visually break mid-string).
  c.font = ARTICLE_PENDING_CODE_FONT;
  const codeWidth =
    c.measureText(ARTICLE_PENDING_CODE).width + ARTICLE_PENDING_CODE_PADDING;
  const codeToken: Token = { text: ARTICLE_PENDING_CODE, width: codeWidth };
  // Single-paragraph result (no \n in the message). Concat prefix tokens
  // → code token → suffix tokens; both prefix and suffix end/start with
  // explicit whitespace so the spaces around the code render correctly.
  placeholderTokens = [
    [...(prefixTokens[0] ?? []), codeToken, ...(suffixTokens[0] ?? [])],
  ];
  return placeholderTokens;
}

function computeArticlePlaceholderHeight(colW: number): number {
  const articleInnerWidth =
    colW - INNER_CONTENT_INSET - ARTICLE_BORDER - ARTICLE_PADDING_HORIZONTAL;
  const tokens = getPlaceholderTokens();
  const messageResult = wrapTokens(tokens, articleInnerWidth);
  return (
    ARTICLE_BORDER +
    ARTICLE_PADDING_VERTICAL +
    ARTICLE_PILL_HEIGHT +
    ARTICLE_PILL_MB +
    messageResult.height
  );
}

// Detect the pending state — bookmark links to an X Article but ft hasn't
// populated `article_title`/`article_text` yet. Server-side filter
// guarantees `bookmark.article` is set ONLY when isXArticle is also true,
// so callers test `!bookmark.article && isXArticle(bookmark)`.
function isXArticle(bookmark: Bookmark): boolean {
  return bookmark.links.some((l) => l.includes("/i/article/"));
}

// Diagnostic breakdown of the components that go into a height calculation.
// Used by the calibration spike to pinpoint where prediction error originates
// (structural constant off by N? text wrap line count wrong? quote
// recursion miscounting?). Not used in production layout — that just
// consumes the total from `computeBookmarkHeight` below.
export type HeightBreakdown = {
  hasPills: boolean;
  hasText: boolean;
  truncated: boolean;
  textLines: number;
  textHeight: number;
  hasArticle: boolean;
  articleHeight: number;
  mediaHeight: number;
  quotedHeight: number;
  quoteTextLines: number;
  sectionsCount: number;
  gaps: number;
  total: number;
  // raw inputs
  rawTextLength: number;
  displayTextLength: number;
};

export function computeBookmarkHeightWithBreakdown(
  bookmark: Bookmark,
  colW: number,
): HeightBreakdown {
  const data = getBodyData(bookmark);
  const innerWidth = colW - INNER_CONTENT_INSET;

  // Article block REPLACES the tweet text section (the tweet body is just
  // the t.co linking to the article — we render the article preview
  // instead). Three states mirror bookmark-card.tsx's conditional render:
  // article enriched → ArticleBlock; X Article URL only → placeholder;
  // neither → tweet text.
  const hasArticle = !!bookmark.article;
  const isPendingArticle = !hasArticle && isXArticle(bookmark);
  const articleHeight = hasArticle
    ? computeArticleBlockHeight(bookmark, colW)
    : isPendingArticle
    ? computeArticlePlaceholderHeight(colW)
    : 0;

  let textHeight = 0;
  let textLines = 0;
  if (!hasArticle && !isPendingArticle && data.displayText) {
    const r = wrapTokens(data.paragraphs, innerWidth);
    textHeight = r.height;
    textLines = r.lines;
    if (data.truncated) textHeight += TRUNCATE_INDICATOR_HEIGHT;
  }
  const mediaHeight =
    bookmark.media && bookmark.media.length > 0
      ? computeMediaHeight(bookmark.media, colW)
      : 0;
  const quoted = bookmark.quotedTweet
    ? computeQuotedHeightDetailed(bookmark.quotedTweet, colW)
    : bookmark.quotedStatusId
    ? { height: MISSING_QUOTE_HEIGHT, textLines: 0 }
    : { height: 0, textLines: 0 };

  const sections: number[] = [];
  sections.push(HEADER_HEIGHT);
  if (data.hasPills) sections.push(pillsHeight(data.pillWidths, innerWidth));
  if (hasArticle || isPendingArticle) sections.push(articleHeight);
  else if (data.displayText) sections.push(textHeight);
  if (mediaHeight > 0) sections.push(mediaHeight);
  if (quoted.height > 0) sections.push(quoted.height);
  sections.push(DATE_FOOTER_BLOCK);

  const gaps = (sections.length - 1) * GAP;
  const total = PADDING_VERTICAL + sections.reduce((a, b) => a + b, 0) + gaps;

  return {
    hasPills: data.hasPills,
    hasText: !!data.displayText && !hasArticle && !isPendingArticle,
    truncated: data.truncated,
    textLines,
    textHeight,
    hasArticle: hasArticle || isPendingArticle,
    articleHeight,
    mediaHeight,
    quotedHeight: quoted.height,
    quoteTextLines: quoted.textLines,
    sectionsCount: sections.length,
    gaps,
    total,
    rawTextLength: (bookmark.text || "").length,
    displayTextLength: data.displayText.length,
  };
}

// Top-level computation. Sums structural sections + inter-section gaps +
// vertical padding. Mirrors BookmarkCard's flex-col gap-3 p-3 layout.
export function computeBookmarkHeight(
  bookmark: Bookmark,
  colW: number,
): number {
  const data = getBodyData(bookmark);
  const innerWidth = colW - INNER_CONTENT_INSET;

  // Each section's intrinsic height, before adding inter-section gaps.
  const sections: number[] = [];
  sections.push(HEADER_HEIGHT);
  if (data.hasPills) sections.push(pillsHeight(data.pillWidths, innerWidth));
  // Article block replaces the tweet text section when present.
  // Pending placeholder when bookmark links to an X Article but ft
  // hasn't enriched it yet (see bookmark-card.tsx for matching render).
  if (bookmark.article) {
    sections.push(computeArticleBlockHeight(bookmark, colW));
  } else if (isXArticle(bookmark)) {
    sections.push(computeArticlePlaceholderHeight(colW));
  } else if (data.displayText) {
    let textH = wrapTokens(data.paragraphs, innerWidth).height;
    if (data.truncated) textH += TRUNCATE_INDICATOR_HEIGHT;
    sections.push(textH);
  }
  if (bookmark.media && bookmark.media.length > 0) {
    sections.push(computeMediaHeight(bookmark.media, colW));
  }
  if (bookmark.quotedTweet) {
    sections.push(computeQuotedHeight(bookmark.quotedTweet, colW));
  } else if (bookmark.quotedStatusId) {
    sections.push(MISSING_QUOTE_HEIGHT);
  }
  // Date + footer block always present.
  sections.push(DATE_FOOTER_BLOCK);

  const gaps = (sections.length - 1) * GAP;
  const sectionsTotal = sections.reduce((a, b) => a + b, 0);
  return PADDING_VERTICAL + sectionsTotal + gaps;
}

// Boundary-aware variant for the DOM-fallback test tab. Same height
// computation as computeBookmarkHeight, but ALSO returns a list of text
// sections (body and/or quote) whose canvas wrap decision was within
// `boundaryThresholdPx` of the wrap boundary. Caller can DOM-measure
// just these sections to confirm/correct the canvas-derived total —
// see bookmark-list-dom.tsx.
//
// `canvasHeight` per section is the canvas-predicted height of that
// text section in isolation (lines × 20 px). DOM measurement returns a
// possibly-different height for the same text + innerWidth; the caller
// computes the corrected total as `canvasTotal + sum(domHeight -
// canvasHeight)` across all sections.
export type BoundaryTextSection = {
  kind: "body" | "quote";
  text: string;
  innerWidth: number;
  canvasHeight: number;
};

export type BookmarkHeightWithBoundary = {
  height: number;
  // Empty when canvas wrap decisions were comfortably away from the
  // boundary — height is reliable as-is. Non-empty when at least one
  // text section is at risk; the test tab DOM-measures these.
  boundaryRisk: BoundaryTextSection[];
};

// Per-bookmark, per-innerWidth memoization. Sidebar toggle and any
// resize that revisits a previously-computed colW (and the associated
// innerWidth) is the hot path: layout's positions useMemo iterates all
// items per RO tick, calling this function once per item. Without
// caching, that's ~10–50 μs × N items = tens of ms per recompute, fired
// 10+ times during a sidebar slide. With caching, the second sidebar
// toggle (back to original width) is a Map lookup per item.
//
// WeakMap keying on Bookmark identity → cache evicts when the bookmarks
// array is replaced (sync, filter, etc). innerWidth is rounded to the
// nearest integer pixel — sub-pixel jitter from RO doesn't bust the
// cache. boundaryThresholdPx isn't part of the key because it's a
// constant in production; if you ever vary it, include it here.
type CachedBookmarkHeight = {
  height: number;
  boundaryRisk: BoundaryTextSection[];
};
const bookmarkHeightCache = new WeakMap<Bookmark, Map<number, CachedBookmarkHeight>>();

export function computeBookmarkHeightWithBoundary(
  bookmark: Bookmark,
  colW: number,
  boundaryThresholdPx: number = 5,
): BookmarkHeightWithBoundary {
  const innerWidthKey = Math.round(colW - INNER_CONTENT_INSET);
  let perBookmark = bookmarkHeightCache.get(bookmark);
  if (perBookmark) {
    const cached = perBookmark.get(innerWidthKey);
    if (cached) return cached;
  } else {
    perBookmark = new Map();
    bookmarkHeightCache.set(bookmark, perBookmark);
  }
  const data = getBodyData(bookmark);
  const innerWidth = colW - INNER_CONTENT_INSET;
  const boundaryRisk: BoundaryTextSection[] = [];

  const sections: number[] = [];
  sections.push(HEADER_HEIGHT);
  if (data.hasPills) sections.push(pillsHeight(data.pillWidths, innerWidth));

  // Article block replaces the tweet text section when present. Boundary
  // detection is intentionally skipped for the title — the DOM-fallback
  // helper hardcodes text-sm and titles are short, so canvas alone is
  // adequate. If a future edge case shows visible drift, plumb className
  // through batchMeasureTextHeights and add an "article-title" kind here.
  // Same skip applies to the pending placeholder — the message is fixed
  // and short.
  if (bookmark.article) {
    sections.push(computeArticleBlockHeight(bookmark, colW));
  } else if (isXArticle(bookmark)) {
    sections.push(computeArticlePlaceholderHeight(colW));
  } else if (data.displayText) {
    const r = wrapTokens(data.paragraphs, innerWidth, boundaryThresholdPx);
    let textH = r.height;
    if (data.truncated) textH += TRUNCATE_INDICATOR_HEIGHT;
    sections.push(textH);
    if (r.hasBoundaryRisk) {
      boundaryRisk.push({
        kind: "body",
        text: data.displayText,
        innerWidth,
        canvasHeight: r.height,
      });
    }
  }

  if (bookmark.media && bookmark.media.length > 0) {
    sections.push(computeMediaHeight(bookmark.media, colW));
  }

  if (bookmark.quotedTweet) {
    const quote = bookmark.quotedTweet;
    const qData = getQuoteData(quote);
    const qOuterWidth = colW - INNER_CONTENT_INSET;
    const qInnerWidth =
      qOuterWidth - QUOTE_BORDER - QUOTE_PADDING_HORIZONTAL;

    let qh =
      QUOTE_BORDER + QUOTE_PADDING_VERTICAL + QUOTE_HEADER_AVATAR;

    if (qData.hasText) {
      qh += QUOTE_HEADER_MB;
      const r = wrapTokens(
        qData.paragraphs,
        qInnerWidth,
        boundaryThresholdPx,
      );
      qh += r.height;
      if (r.hasBoundaryRisk) {
        boundaryRisk.push({
          kind: "quote",
          text: qData.displayText,
          innerWidth: qInnerWidth,
          canvasHeight: r.height,
        });
      }
    }

    if (qData.hasMedia) {
      qh += qData.hasText
        ? QUOTE_MEDIA_MT
        : Math.max(QUOTE_HEADER_MB, QUOTE_MEDIA_MT);
      if (quote.media.length === 1) {
        const m = quote.media[0];
        if (m.width && m.height) {
          const aspectHeight = Math.round(qInnerWidth * (m.height / m.width));
          qh += Math.min(QUOTE_MAX_SOLO_MEDIA_HEIGHT, aspectHeight);
        } else {
          qh += QUOTE_MAX_SOLO_MEDIA_HEIGHT;
        }
      } else {
        const count = Math.min(4, quote.media.length);
        const gapTotal = (count - 1) * 4;
        const itemSize = (qInnerWidth - gapTotal) / count;
        qh += itemSize;
      }
    }

    if (!qData.hasText && !qData.hasMedia) {
      qh += QUOTE_HEADER_MB;
    }

    sections.push(qh);
  } else if (bookmark.quotedStatusId) {
    sections.push(MISSING_QUOTE_HEIGHT);
  }

  sections.push(DATE_FOOTER_BLOCK);

  const gaps = (sections.length - 1) * GAP;
  const sectionsTotal = sections.reduce((a, b) => a + b, 0);
  const height = PADDING_VERTICAL + sectionsTotal + gaps;

  const result: CachedBookmarkHeight = { height, boundaryRisk };
  perBookmark.set(innerWidthKey, result);
  return result;
}
