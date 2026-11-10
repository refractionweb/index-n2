/* eslint-disable react-refresh/only-export-components */
import type { MouseEvent } from "react";
import { MediaPlaceholder } from "@/components/media-placeholder";
import { highlightText } from "@/lib/highlight";
import { cn } from "@/lib/utils";

// Single source of truth for "link to an X.com profile." Dedupes the hardcoded
// `https://x.com/${handle}` in BookmarkCard and LightboxCardPanel; also owns
// the pfp + name + handle layout that both places were duplicating.

const X_BASE = "https://x.com";

export function xProfileUrl(handle: string): string {
  return `${X_BASE}/${handle}`;
}

const SIZE_MAP = {
  sm: {
    pfp: "size-9",
    name: "text-sm font-medium",
    handle: "text-xs",
  },
  md: {
    pfp: "size-10",
    name: "font-medium",
    handle: "text-xs",
  },
} as const;

export function AuthorLink({
  handle,
  name,
  pfp,
  size = "sm",
  className,
  highlight,
}: {
  handle: string;
  name: string;
  pfp: string | null;
  size?: keyof typeof SIZE_MAP;
  className?: string;
  // Optional search term — when set, wraps matches in both `name` and
  // `handle` with <mark>. The `@` prefix stays outside the highlight.
  highlight?: string;
}) {
  const s = SIZE_MAP[size];
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <a
      href={xProfileUrl(handle)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      className={cn(
        // `self-start` prevents cross-axis stretch when this link sits inside a
        // flex-col container (e.g. the lightbox card panel). Without it the
        // anchor fills the panel width and `group-hover:underline` fires over
        // empty space to the right of the text.
        "group flex min-w-0 items-center gap-2 self-start text-inherit no-underline",
        className
      )}
    >
      {pfp ? (
        <img
          src={pfp}
          alt=""
          loading="lazy"
          className={cn("shrink-0 rounded-full object-cover", s.pfp)}
        />
      ) : (
        <MediaPlaceholder className={cn("shrink-0 rounded-full", s.pfp)} />
      )}
      <div className="flex min-w-0 flex-col">
        <span className={cn("truncate group-hover:underline", s.name)}>
          {highlight ? highlightText(name, highlight) : name}
        </span>
        <span className={cn("text-muted-foreground truncate", s.handle)}>
          @{highlight ? highlightText(handle, highlight) : handle}
        </span>
      </div>
    </a>
  );
}
