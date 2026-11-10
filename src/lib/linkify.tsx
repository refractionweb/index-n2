import type { ReactNode } from "react";
import { shortenUrlForDisplay } from "@/lib/format";
import { highlightText } from "@/lib/highlight";

// Turn plain text into React nodes where URLs and @mentions become clickable
// <a>s and — if `highlight` is set — other text segments get their matches
// wrapped in <mark>. Operates on React nodes instead of HTML strings, so we
// never have to sanitize HTML or worry about putting <mark> inside an href.
//
// The lookbehind `(?<=^|\s)` on the @mention alternative means a mention must
// sit at the start of the string or after whitespace, which avoids false
// positives on "foo@bar.com"-style fragments.
const TOKEN = /(https?:\/\/\S+|(?<=^|\s)@\w+)/g;
const LINK_CLASS = "text-primary hover:underline";

export function linkifyText(text: string, highlight?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  for (const part of text.split(TOKEN)) {
    if (!part) continue;
    if (/^https?:\/\//.test(part)) {
      // Strip protocol, drop trailing slash, truncate to 30 chars — keeps
      // long links from blowing out the card. The height predictor measures
      // this same display string, so the rule is shared (not mirrored) via
      // shortenUrlForDisplay.
      const display = shortenUrlForDisplay(part);
      out.push(
        <a
          key={key++}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK_CLASS}
          onClick={(e) => e.stopPropagation()}
        >
          {display}
        </a>
      );
      continue;
    }
    if (/^@\w+$/.test(part)) {
      const handle = part.slice(1);
      out.push(
        <a
          key={key++}
          href={`https://x.com/${handle}`}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK_CLASS}
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      );
      continue;
    }
    if (highlight) {
      for (const node of highlightText(part, highlight)) {
        if (typeof node === "string") {
          out.push(node);
        } else {
          out.push(<span key={key++}>{node}</span>);
        }
      }
    } else {
      out.push(part);
    }
  }
  return out;
}
