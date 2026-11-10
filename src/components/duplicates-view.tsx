import { useEffect, useMemo, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import { StatusMessage } from "@/components/status-message";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useBookmarks } from "@/contexts/bookmarks-context";
import type { Bookmark, MediaItem } from "@/types/bookmark";

type DupData = {
  imageDupes: string[][];
  textDupes: string[][];
};

// Pretty-print the gap between two timestamps for the "X apart" piece of a
// group's relationship summary. Bands match standard time-pretty rounding;
// "minutes apart" is reserved for sub-1h spans (see ui-copy notes).
function spanLabel(ms: number): string {
  const minutes = ms / 60_000;
  const hours = minutes / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30.44;
  const years = days / 365.25;
  if (hours < 1) return "minutes apart";
  if (hours < 24) {
    const h = Math.round(hours);
    return `${h} ${h === 1 ? "hour" : "hours"} apart`;
  }
  if (days < 7) {
    const d = Math.round(days);
    return `${d} ${d === 1 ? "day" : "days"} apart`;
  }
  if (weeks < 4) {
    const w = Math.round(weeks);
    return `${w} ${w === 1 ? "week" : "weeks"} apart`;
  }
  if (months < 12) {
    const m = Math.round(months);
    return `${m} ${m === 1 ? "month" : "months"} apart`;
  }
  const y = Math.round(years);
  return `${y} ${y === 1 ? "year" : "years"} apart`;
}

// Compact relative date for the per-thumb metadata under each image. Single-
// letter unit so columns can stay narrow even when the image is portrait.
function relativeDate(postedAt: string | null): string {
  if (!postedAt) return "";
  const t = new Date(postedAt).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  const minutes = ms / 60_000;
  const hours = minutes / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30.44;
  const years = days / 365.25;
  if (hours < 1) return `${Math.max(1, Math.round(minutes))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  if (days < 7) return `${Math.round(days)}d`;
  if (weeks < 4) return `${Math.round(weeks)}w`;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${Math.round(years)}y`;
}

function parseDate(s: string | null): number {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

type GroupCard = {
  bookmark: Bookmark;
  // Image-side only: the specific media item from this bookmark that landed
  // in the dedup group. Drives the collapsed-state thumbnail. Null for text
  // groups.
  matchedMedia: MediaItem | null;
  dimmedMediaUrls?: ReadonlySet<string>;
};

function relationshipSummary(cards: GroupCard[]): string {
  const handles = new Set(cards.map((c) => c.bookmark.authorHandle));
  const ts = cards
    .map((c) => parseDate(c.bookmark.postedAt))
    .filter((t) => t > 0);
  const timePart =
    ts.length >= 2 ? spanLabel(Math.max(...ts) - Math.min(...ts)) : null;

  // Detect a quote-tweet relationship inside the group: any bookmark whose
  // quotedTweet.id matches another bookmark's id. The match is real signal,
  // but it's already represented by the quote-tweet — annotate so the user
  // reads "this overlap is explained by the quote chain" instead of
  // mistaking it for an independent visual coincidence.
  const idsInGroup = new Set(cards.map((c) => c.bookmark.id));
  let quotePair: { quoter: string; quoted: string } | null = null;
  for (const c of cards) {
    const qid = c.bookmark.quotedTweet?.id;
    if (qid && idsInGroup.has(qid)) {
      const quoted = cards.find((x) => x.bookmark.id === qid);
      if (quoted) {
        quotePair = {
          quoter: c.bookmark.authorHandle,
          quoted: quoted.bookmark.authorHandle,
        };
        break;
      }
    }
  }

  // Two-card cross-author quote: name the actors directly.
  if (
    cards.length === 2 &&
    quotePair &&
    quotePair.quoter !== quotePair.quoted
  ) {
    const parts = [`@${quotePair.quoter} quotes @${quotePair.quoted}`];
    if (timePart) parts.push(timePart);
    return parts.join(" · ");
  }

  // Otherwise: standard author + time, with quote-tweet annotation when any
  // pair is in a quote relationship (covers 3+ card groups and self-quotes).
  const authorPart =
    handles.size === 1 ? "same author" : `${handles.size} authors`;
  const parts = [authorPart];
  if (timePart) parts.push(timePart);
  if (quotePair) parts.push("contains quote-tweet");
  return parts.join(" · ");
}

export function DuplicatesView() {
  const { bookmarks, byId } = useBookmarks();
  const [dupData, setDupData] = useState<DupData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/duplicates")
      .then(async (r) => {
        if (!r.ok) throw new Error(`/api/duplicates → HTTP ${r.status}`);
        return r.json();
      })
      .then((d: DupData) => setDupData(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load /api/duplicates"));
  }, []);

  const fileToBookmark = useMemo(() => {
    const map = new Map<string, { bookmark: Bookmark; mediaUrl: string }>();
    if (!bookmarks) return map;
    for (const b of bookmarks) {
      for (const m of b.media || []) {
        if (!m.url) continue;
        const filename = m.url.split("/").pop();
        if (filename) map.set(filename, { bookmark: b, mediaUrl: m.url });
      }
    }
    return map;
  }, [bookmarks]);

  const mergedImageGroups = useMemo(() => {
    if (!dupData) return [];
    const mergedKeyMap = new Map<string, string[]>();
    const groups: string[][] = [];
    for (const group of dupData.imageDupes) {
      const ids = new Set<string>();
      for (const f of group) {
        const info = fileToBookmark.get(f);
        if (info) ids.add(info.bookmark.id);
      }
      const key = [...ids].sort().join(",");
      if (mergedKeyMap.has(key)) {
        mergedKeyMap.get(key)!.push(...group);
      } else {
        const merged = [...group];
        mergedKeyMap.set(key, merged);
        groups.push(merged);
      }
    }
    // Sort: distinct-bookmark count desc → max(postedAt) desc. Larger groups
    // (recycling clusters / memes) are higher-signal than 2-card collisions
    // and surface first; the long 2-card tail breaks the tie by recency.
    const decorated = groups.map((g) => {
      const seen = new Set<string>();
      let maxPostedAt = 0;
      for (const f of g) {
        const info = fileToBookmark.get(f);
        if (!info || seen.has(info.bookmark.id)) continue;
        seen.add(info.bookmark.id);
        const t = parseDate(info.bookmark.postedAt);
        if (t > maxPostedAt) maxPostedAt = t;
      }
      return { g, size: seen.size, recency: maxPostedAt };
    });
    decorated.sort(
      (a, b) => b.size - a.size || b.recency - a.recency,
    );
    return decorated.map((d) => d.g);
  }, [dupData, fileToBookmark]);

  const sortedTextDupes = useMemo(() => {
    if (!dupData) return [];
    const decorated = dupData.textDupes.map((ids) => {
      let maxPostedAt = 0;
      for (const id of ids) {
        const b = byId.get(id);
        if (!b) continue;
        const t = parseDate(b.postedAt);
        if (t > maxPostedAt) maxPostedAt = t;
      }
      return { ids, size: ids.length, recency: maxPostedAt };
    });
    decorated.sort(
      (a, b) => b.size - a.size || b.recency - a.recency,
    );
    return decorated.map((d) => d.ids);
  }, [dupData, byId]);

  if (error) {
    return (
      <StatusMessage variant="destructive">{error}</StatusMessage>
    );
  }
  if (!dupData) {
    return (
      <StatusMessage>Loading duplicates…</StatusMessage>
    );
  }

  return (
    <div className="flex flex-col gap-8 pb-8">
      <section>
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          Image duplicates ({mergedImageGroups.length} groups)
        </h2>
        {mergedImageGroups.length === 0 ? (
          <StatusMessage>No duplicate images found</StatusMessage>
        ) : (
          <Accordion type="multiple">
            {mergedImageGroups.map((group, g) => (
              <ImageDupGroup
                key={g}
                value={`img-${g}`}
                filenames={group}
                fileToBookmark={fileToBookmark}
              />
            ))}
          </Accordion>
        )}
      </section>

      <section>
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          Text duplicates ({sortedTextDupes.length} groups)
        </h2>
        {sortedTextDupes.length === 0 ? (
          <StatusMessage>No duplicate texts found</StatusMessage>
        ) : (
          <Accordion type="multiple">
            {sortedTextDupes.map((ids, g) => (
              <TextDupGroup key={g} value={`txt-${g}`} ids={ids} byId={byId} />
            ))}
          </Accordion>
        )}
      </section>
    </div>
  );
}

function ImageDupGroup({
  value,
  filenames,
  fileToBookmark,
}: {
  value: string;
  filenames: string[];
  fileToBookmark: ReadonlyMap<string, { bookmark: Bookmark; mediaUrl: string }>;
}) {
  const cards = useMemo(() => {
    const matchedMediaUrls = new Set(filenames.map((f) => `/media/${f}`));
    const seen = new Set<string>();
    const out: GroupCard[] = [];
    for (const filename of filenames) {
      const info = fileToBookmark.get(filename);
      if (!info || seen.has(info.bookmark.id)) continue;
      seen.add(info.bookmark.id);
      const matched = info.bookmark.media.find(
        (m) => m.url && m.url.split("/").pop() === filename,
      );
      const dimmed = new Set<string>();
      for (const mm of info.bookmark.media || []) {
        if (!mm.url) continue;
        if (
          !matchedMediaUrls.has(mm.url) &&
          !matchedMediaUrls.has(mm.url.replace("/thumbs/", "/media/"))
        ) {
          dimmed.add(mm.url);
        }
      }
      out.push({
        bookmark: info.bookmark,
        matchedMedia: matched ?? null,
        dimmedMediaUrls: dimmed.size > 0 ? dimmed : undefined,
      });
    }
    out.sort((a, b) => parseDate(a.bookmark.postedAt) - parseDate(b.bookmark.postedAt));
    return out;
  }, [filenames, fileToBookmark]);

  if (cards.length < 2) return null;
  return <DupGroupShell value={value} kind="image" cards={cards} />;
}

function TextDupGroup({
  value,
  ids,
  byId,
}: {
  value: string;
  ids: string[];
  byId: ReadonlyMap<string, Bookmark>;
}) {
  const cards = useMemo(() => {
    const out: GroupCard[] = [];
    for (const id of ids) {
      const b = byId.get(id);
      if (b) out.push({ bookmark: b, matchedMedia: null });
    }
    out.sort((a, b) => parseDate(a.bookmark.postedAt) - parseDate(b.bookmark.postedAt));
    return out;
  }, [ids, byId]);

  if (cards.length < 2) return null;
  return <DupGroupShell value={value} kind="text" cards={cards} />;
}

// One group as an Accordion item. Trigger holds the always-visible summary
// line + per-kind preview (image strip or text snippet); content holds the
// full-card scroll row that reveals on expand.
function DupGroupShell({
  value,
  kind,
  cards,
}: {
  value: string;
  kind: "image" | "text";
  cards: GroupCard[];
}) {
  const summary = relationshipSummary(cards);

  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="text-sm">
        <span className="tabular-nums">{summary}</span>
      </AccordionTrigger>
      {/* Preview sits outside the trigger so clicks on it don't toggle the
          accordion. Trigger is the summary line only — reserves the preview
          surface for per-card actions (open lightbox per thumb, etc.) we
          may wire later, and keeps the trigger valid HTML (no interactive
          descendants nested inside the trigger button). */}
      <div className="px-2 pb-2">
        {kind === "image" ? (
          <ImageThumbStrip cards={cards} />
        ) : (
          <TextSnippet cards={cards} />
        )}
      </div>
      <AccordionContent className="px-0 text-sm [&_a]:no-underline">
        {/* `items-start` so cards hug their own content height instead of
            stretching to the tallest card. `pt-0.5` reserves 2px above the
            card border + selection ring so they aren't shaved by the scroll
            container's clip rect. `pb-2` for scrollbar clearance.

            `px-2` lives inside the scroll row, so it's part of the scroll
            content — at scroll-0 it gives the first card 8px breathing room
            (matches trigger/preview alignment); as the user scrolls right
            it slides out of view, letting cards travel edge-to-edge of the
            AccordionItem. */}
        <div className="flex items-start gap-3 overflow-x-auto pt-0.5 pb-2 px-2 [&>*]:w-[400px] [&>*]:shrink-0">
          {cards.map(({ bookmark, dimmedMediaUrls }) => (
            <BookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              dimmedMediaUrls={dimmedMediaUrls}
            />
          ))}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

// Image collapsed state: per-card column with thumb (max 80×80, aspect
// preserved → image's actual rendered height is up to 80; landscape ends up
// shorter, portrait stays narrower than 80) and handle + relative-date stack
// underneath. Row is `items-end` so columns share a baseline at the metadata
// line; varying thumb heights give a "skyline" above that baseline.
function ImageThumbStrip({ cards }: { cards: GroupCard[] }) {
  return (
    <div className="flex items-end gap-3 overflow-x-auto pb-1">
      {cards.map(({ bookmark, matchedMedia }) => {
        const src = matchedMedia?.thumb || matchedMedia?.url || null;
        return (
          <div
            key={bookmark.id}
            className="flex shrink-0 flex-col items-center gap-1"
          >
            {src ? (
              <img
                src={src}
                alt=""
                loading="lazy"
                className="max-h-[100px] max-w-[100px] shrink-0"
              />
            ) : (
              <div className="bg-muted h-[100px] w-[100px] shrink-0" />
            )}
            <span className="text-foreground text-xs">
              @{bookmark.authorHandle}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {relativeDate(bookmark.postedAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Text collapsed state: two-line preview of the matched text in a subtle
// excerpt box, with the same typographic treatment as tweet body text in
// BookmarkCard (text-sm, break-words, whitespace-pre-wrap, full contrast).
// All cards in a group share the same normalized text but typically differ in
// the trailing t.co shortcode (each repost gets its own); strip any Twitter
// URL from the preview since they're per-tweet noise, not matched content.
function TextSnippet({ cards }: { cards: GroupCard[] }) {
  const text = stripTwitterUrls(cards[0]?.bookmark.text || "");
  return (
    <p className="line-clamp-2 text-sm break-words whitespace-pre-wrap">
      <span className="bg-foreground/10 box-decoration-clone rounded-sm px-px">
        {text}
      </span>
    </p>
  );
}

function stripTwitterUrls(text: string): string {
  return text
    .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, "")
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
