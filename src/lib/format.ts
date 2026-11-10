export function fmtNum(n: number | null | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const val = n / 1000;
    return val < 10 ? val.toFixed(1).replace(/\.0$/, "") + "K" : Math.round(val) + "K";
  }
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

export function fmtAbsoluteDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${time} · ${date}`;
}

// Relative-time formatter. "2 days ago", "4 hours ago", etc. Uses the
// platform's Intl.RelativeTimeFormat — no external dep. Returns "" for
// null/invalid input so callers can pass through directly. Picks the
// largest meaningful unit; doesn't compose ("1 day, 4 hours" — out of
// scope for the lightbox Details row).
export function fmtRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  const diffSec = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), "day");
  if (abs < 86_400 * 365) return rtf.format(Math.round(diffSec / (86_400 * 30)), "month");
  return rtf.format(Math.round(diffSec / (86_400 * 365)), "year");
}

// Compact date for secondary contexts (quoted tweets, list rows). Shows
// "Apr 23" when the year matches now, "Apr 23, 2025" otherwise. No time.
export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

// Display form of a single URL: strip protocol, drop trailing slash, truncate
// past 30 chars. THE one definition of this rule — consumed by both the
// renderer (linkify.tsx, per URL token) and the height predictor
// (compute-bookmark-height.ts, over a whole string). They previously held
// byte-identical inline copies behind a "KEEP IN SYNC" comment; a quote-path
// site that forgot to apply it caused persistent layout gaps.
export function shortenUrlForDisplay(url: string): string {
  const display = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return display.length > 30 ? display.slice(0, 30) + "…" : display;
}

// Replace each t.co/xxx in text with the corresponding expanded URL from `links`,
// in document order. Any t.co without a matching entry is stripped — media-only
// tweets ship as {text: "... https://t.co/xxx", links: []} where the trailing
// t.co is a self-link to the tweet's own media.
export function expandTcoLinks(text: string, links: string[]): string {
  if (!text) return text;
  let idx = 0;
  const n = links?.length ?? 0;
  return text
    .replace(/https?:\/\/t\.co\/\S+/g, () => (idx < n ? links[idx++] : ""))
    .trim();
}
