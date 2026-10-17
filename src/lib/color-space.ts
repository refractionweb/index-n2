// sRGB ↔ HSV ↔ hex conversions. For Lab / deltaE, see color-math.ts.

export type Hsv = { h: number; s: number; v: number };

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r: number, g: number, b: number;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {
    h: Math.round(h),
    s: Math.round((max === 0 ? 0 : d / max) * 100),
    v: Math.round(max * 100),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Display form of a stored "#rrggbb" hex: bare uppercase digits ("FF8800").
// Storage keeps rgbToHex's lowercase "#rrggbb" so preset matching compares
// one canonical form.
export function displayHex(hex: string): string {
  return hex.replace("#", "").toUpperCase();
}

// Expand a 1-3 digit hex fragment to 6 digits. 1 and 2 digits repeat to
// fill ("d" → "dddddd", "3f" → "3f3f3f" — no CSS equivalent exists). 3
// digits double per digit, matching CSS #rgb shorthand ("f80" → "ff8800",
// NOT "f80f80"). Anything else returns null.
export function expandHexShorthand(fragment: string): string | null {
  if (!/^[0-9a-f]{1,3}$/i.test(fragment)) return null;
  if (fragment.length === 3)
    return fragment
      .split("")
      .map((c) => c + c)
      .join("");
  return fragment.repeat(6 / fragment.length);
}

export type ColorPreset =
  | { name: string; special: "mono" }
  | { name: string; hex: string };

export const COLOR_PRESETS: readonly ColorPreset[] = [
  { name: "Mono", special: "mono" },
  { name: "Black", hex: "#000000" },
  { name: "White", hex: "#ffffff" },
  { name: "Gray", hex: "#808080" },
  { name: "Red", hex: "#e63946" },
  { name: "Orange", hex: "#f4a261" },
  { name: "Yellow", hex: "#f1c40f" },
  { name: "Lime", hex: "#a8d63a" },
  { name: "Green", hex: "#3aa55a" },
  { name: "Cyan", hex: "#3ec1c8" },
  { name: "Blue", hex: "#3a86d9" },
  { name: "Purple", hex: "#9b59b6" },
  { name: "Pink", hex: "#e75e8d" },
  { name: "Brown", hex: "#8b5a2b" },
];
