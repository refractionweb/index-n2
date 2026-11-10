// Reply tweets often start with a run of @handles: "@alice @bob actual body".
// Split that run off so it can render as pills and the body stays clean.

export type ExtractedHandles = {
  handles: string[];
  rest: string;
};

export function extractReplyHandles(text: string): ExtractedHandles {
  const m = text.match(/^((?:@\w+(?:\s+|$))+)/);
  if (!m) return { handles: [], rest: text };
  const handles = m[1]
    .trim()
    .split(/\s+/)
    .map((h) => h.replace(/^@/, ""));
  return { handles, rest: text.slice(m[0].length) };
}
