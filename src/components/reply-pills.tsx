import type { MouseEvent } from "react";
import {
  RiArchiveLine,
  RiCornerUpLeftDoubleLine,
  RiCornerUpLeftLine,
} from "@remixicon/react";
import { Badge } from "@/components/ui/badge";

// Reply / Thread / Archived state badges. Reply + thread are clickable links
// (via Badge's `asChild` slot — Badge picks up its hover styles when the
// rendered element matches `[a]`, see badge.tsx variants). Archived is a
// static state indicator, not a link. First reply pill carries the
// corner-arrow icon (double if 2+ handles, single otherwise).
//
// All three render inside one flex-wrap row when present, so they sit on
// the same line. Reply and thread are mutually exclusive (reply takes
// priority when both apply); archived is orthogonal and can co-occur.

const stop = (e: MouseEvent) => e.stopPropagation();

export function ReplyOrThreadPills({
  handles,
  isThread,
  isArchived = false,
  url,
}: {
  handles: string[];
  isThread: boolean;
  isArchived?: boolean;
  url: string;
}) {
  const hasReply = handles.length > 0;
  const showThread = !hasReply && isThread;
  if (!hasReply && !showThread && !isArchived) return null;

  const ReplyIcon =
    handles.length >= 2 ? RiCornerUpLeftDoubleLine : RiCornerUpLeftLine;

  return (
    <div className="flex flex-wrap gap-1">
      {hasReply &&
        handles.map((h, i) => (
          <Badge key={`r${i}`} variant="outline" asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
            >
              {i === 0 && <ReplyIcon />}
              <span>@{h}</span>
            </a>
          </Badge>
        ))}
      {showThread && (
        <Badge variant="outline" asChild>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stop}
          >
            <RiCornerUpLeftLine />
            <span>Thread</span>
          </a>
        </Badge>
      )}
      {isArchived && (
        <Badge variant="outline">
          <RiArchiveLine />
          <span>Archived</span>
        </Badge>
      )}
    </div>
  );
}
