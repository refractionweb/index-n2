// Given a user-selected color filter and per-media color stats, decide whether
// the media (or any media in a bookmark) matches.

import type { ColorSelection } from "@/components/color-picker";
import type { Bookmark, ColorData } from "@/types/bookmark";
import { deltaE, rgbToLab } from "@/lib/color-math";
import { hexToRgb } from "@/lib/color-space";

const COLOR_ACCURACY = 15; // Delta E threshold

function targetLab(color: ColorSelection) {
  if ("special" in color) return null;
  const rgb = hexToRgb(color.hex);
  if (!rgb) return null;
  return rgbToLab(rgb[0], rgb[1], rgb[2]);
}

export function matchMediaColor(
  stats: ColorData | null,
  color: ColorSelection | null
): boolean {
  if (!stats || !color || !stats.palette) return false;

  if ("special" in color) {
    if (color.special === "mono") {
      return (
        stats.avgChroma < 12 &&
        stats.palette.every((c) => Math.sqrt(c.a ** 2 + c.b ** 2) < 12)
      );
    }
    return false;
  }

  const lab = targetLab(color);
  if (!lab) return false;
  const chroma = Math.sqrt(lab.a ** 2 + lab.b ** 2);

  // Near-grayscale picks: match by aggregate L.
  if (chroma < 5) {
    if (lab.L < 25) return stats.avgL < 25;
    if (lab.L > 80) return stats.avgL > 80 && stats.avgChroma < 15;
    return stats.avgChroma < 12 && Math.abs(stats.avgL - lab.L) < 20;
  }

  // Population-weighted Delta E across the palette.
  let bestScore = Infinity;
  for (const c of stats.palette) {
    const d = deltaE({ L: c.L, a: c.a, b: c.b }, lab);
    const score = d / Math.sqrt(c.w + 0.01);
    if (score < bestScore) bestScore = score;
  }
  // Adaptive threshold: mid-L has wider chroma range, so allow more slack there.
  const distFromMid = Math.abs(lab.L - 50) / 50;
  const expansion = 1 + (1 - distFromMid) * 1.5;
  return bestScore < COLOR_ACCURACY * expansion;
}

export function bookmarkMatchesColor(
  bookmark: Bookmark,
  color: ColorSelection | null
): boolean {
  if (!color) return true;
  if (!bookmark.media.length) return false;
  for (const m of bookmark.media) {
    if (matchMediaColor(m.colors, color)) return true;
  }
  return false;
}
