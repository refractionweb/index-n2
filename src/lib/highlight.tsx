import type { ReactNode } from "react";

// Escape regex metacharacters so a literal search term like "a.b" doesn't
// become a wildcard.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalize the raw filter-state search to what we actually match against —
// trimmed, lowercased, with a leading `@` stripped. Mirrors `filterBookmarks`
// so the highlight can never disagree with what the filter selected.
export function normalizeSearchTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "");
}

// Split `text` on `term` (case-insensitive) and wrap each match in a <mark>.
// The split regex's capturing group produces [before, match, after, match, …];
// odd indices are the matches.
export function highlightText(text: string, term: string): ReactNode[] {
  if (!term) return [text];
  const re = new RegExp(`(${escapeRegex(term)})`, "gi");
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        // -mx-px cancels px-px so the highlight adds no inline width: card
        // heights are predicted from the plain text, and 2px per match is
        // enough to push a line onto a new row.
        className="bg-foreground/15 text-foreground -mx-px rounded-sm px-px"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}
