import type { Bookmark } from "@/types/bookmark";

// Map full + 3-letter month names to 0-11. Built once at module load.
const MONTH_MAP: Record<string, number> = (() => {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const map: Record<string, number> = {};
  months.forEach((m, i) => {
    map[m] = i;
    map[m.slice(0, 3)] = i;
  });
  return map;
})();

const DAY_MS = 86400000;

// Two shapes:
//   { start, end }       — closed-open range; bookmarks where start <= postedAt < end
//   { month, day? }      — match the month (and optionally day) of postedAt in ANY year
//                          (start/end stay null in this case)
export type DateFilter = {
  start: Date | null;
  end: Date | null;
  month?: number;
  day?: number;
};

// Parse a search query into a DateFilter, or null if the query isn't
// date-shaped. The whole query must be a date expression: every token has
// to be a month name, a day, or a year. A date word inside an ordinary
// query ("jan koum", "today i learned", "react 2025 roadmap") stays a text
// search; otherwise the date match, which is ORed with the text match,
// would pull in every bookmark from that period. Handle searches ("@jan")
// never parse as dates.
export function parseDateQuery(term: string): DateFilter | null {
  if (!term) return null;
  const normalized = term.toLowerCase().trim();
  if (!normalized || normalized.startsWith("@")) return null;
  // Commas separate tokens so "apr 5, 2024" reads as month + day + year.
  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  const now = new Date();

  const phrase = tokens.join(" ");
  if (phrase === "today") {
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: s, end: new Date(s.getTime() + DAY_MS) };
  }
  if (phrase === "yesterday") {
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { start: s, end: new Date(s.getTime() + DAY_MS) };
  }

  if (phrase === "this week") {
    const day = now.getDay();
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    return { start: s, end: new Date(s.getTime() + 7 * DAY_MS) };
  }
  if (phrase === "last week") {
    const day = now.getDay();
    const s = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - day - 7
    );
    return { start: s, end: new Date(s.getTime() + 7 * DAY_MS) };
  }
  if (phrase === "this month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }
  if (phrase === "last month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
    };
  }
  if (phrase === "this year") {
    return {
      start: new Date(now.getFullYear(), 0, 1),
      end: new Date(now.getFullYear() + 1, 0, 1),
    };
  }
  if (phrase === "last year") {
    return {
      start: new Date(now.getFullYear() - 1, 0, 1),
      end: new Date(now.getFullYear(), 0, 1),
    };
  }

  // "last N days/weeks/months" or "past N …"
  const rangeMatch = normalized.match(
    /^(?:last|past)\s+(\d+)\s+(days?|weeks?|months?)$/
  );
  if (rangeMatch) {
    const n = parseInt(rangeMatch[1], 10);
    const unit = rangeMatch[2].replace(/s$/, "");
    const s = new Date(now);
    if (unit === "day") s.setDate(s.getDate() - n);
    else if (unit === "week") s.setDate(s.getDate() - n * 7);
    else if (unit === "month") s.setMonth(s.getMonth() - n);
    return { start: s, end: now };
  }

  // Free-form: month name, day, year — any combination, any order. Any
  // other token, or a second month / day / year, means the query isn't a
  // date.
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  for (const t of tokens) {
    if (MONTH_MAP[t] !== undefined) {
      if (month !== null) return null;
      month = MONTH_MAP[t];
    } else if (/^\d{4}$/.test(t)) {
      if (year !== null) return null;
      year = parseInt(t, 10);
    } else if (/^\d{1,2}$/.test(t)) {
      const n = parseInt(t, 10);
      if (day !== null || n < 1 || n > 31) return null;
      day = n;
    } else {
      return null;
    }
  }

  if (month === null && year === null) return null;

  // Year only: "2024". A day without a month ("5 2024") isn't a date.
  if (month === null && year !== null) {
    if (day !== null) return null;
    return {
      start: new Date(year, 0, 1),
      end: new Date(year + 1, 0, 1),
    };
  }
  // Month only: "april" → that month in every year
  if (month !== null && year === null && day === null) {
    return { start: null, end: null, month };
  }
  // Month + year: "april 2024"
  if (month !== null && year !== null && day === null) {
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 1),
    };
  }
  // Month + day: "apr 5" → that day-of-month in every year
  if (month !== null && day !== null && year === null) {
    return { start: null, end: null, month, day };
  }
  // Month + day + year: "apr 5 2024"
  if (month !== null && day !== null && year !== null) {
    const s = new Date(year, month, day);
    return { start: s, end: new Date(s.getTime() + DAY_MS) };
  }
  return null;
}

export function matchesDateFilter(b: Bookmark, df: DateFilter): boolean {
  if (!b.postedAt) return false;
  const d = new Date(b.postedAt);
  // "Any year" branch — month and optional day, no concrete range.
  if (df.month !== undefined && df.start === null) {
    if (df.day !== undefined) {
      return d.getMonth() === df.month && d.getDate() === df.day;
    }
    return d.getMonth() === df.month;
  }
  // Concrete range.
  return df.start !== null && df.end !== null && d >= df.start && d < df.end;
}
