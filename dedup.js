// Duplicate detection: pHash for images, normalized text matching.
// Stores results in .cache/dedup.json. Skips files already cached.

import sharp from "sharp";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-write.js";

let CACHE_DIR, DEDUP_PATH;

export function setCacheDir(dir) {
  CACHE_DIR = dir;
  DEDUP_PATH = join(dir, "dedup.json");
}
const PHASH_THRESHOLD = 9;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// --- pHash: perceptual hash ---
// Resize to 32x32 grayscale, 2D DCT, threshold 8x8 low-frequency block → 64-bit hash

function dct2d(matrix, size) {
  function dct1d(input) {
    const N = input.length;
    const output = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let n = 0; n < N; n++) {
        sum += input[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
      }
      output[k] = sum;
    }
    return output;
  }
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(dct1d(matrix.slice(y * size, (y + 1) * size)));
  }
  const result = new Float64Array(size * size);
  for (let x = 0; x < size; x++) {
    const col = new Float64Array(size);
    for (let y = 0; y < size; y++) col[y] = rows[y][x];
    const dctCol = dct1d(col);
    for (let y = 0; y < size; y++) result[y * size + x] = dctCol[y];
  }
  return result;
}

async function computeHash(filePath) {
  try {
    const { data } = await sharp(filePath)
      .resize(32, 32, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const dct = dct2d(new Float64Array(data), 32);

    // Top-left 8x8 low-frequency block, skip DC component
    const block = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        if (y !== 0 || x !== 0) block.push(dct[y * 32 + x]);

    const sorted = [...block].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const bits = block.map(v => v > median ? 1 : 0);
    bits.push(0); // pad to 64

    let hex = "";
    for (let i = 0; i < 64; i += 4)
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    return hex;
  } catch { return null; }
}

function hammingDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

// --- Text dedup ---

function normalizeText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, "")
    .replace(/@\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Pre-filter: skip truly uniform images (solid color = meaningless hash) ---

function isReliableHash(colors) {
  if (!colors || !colors.palette?.length) return true;
  return colors.palette[0].w <= 0.90;
}

// --- Build / load cache ---

export async function buildDedupCache(mediaDir, manifestPath, bookmarks, colorCache, onProgress) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  let cache = { hashes: {}, imageGroupsKey: null, imageDupes: null };
  if (existsSync(DEDUP_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(DEDUP_PATH, "utf-8"));
      if (raw.hashes) cache.hashes = raw.hashes;
      if (typeof raw.imageGroupsKey === "string") cache.imageGroupsKey = raw.imageGroupsKey;
      if (Array.isArray(raw.imageDupes)) cache.imageDupes = raw.imageDupes;
    } catch {}
  }

  // Build two manifest-derived sets in one pass.
  //   trackedFiles — every file the manifest knows about. Files on disk but
  //     not in the manifest are leftovers from older ft CLI naming schemes
  //     (commonly per-bookmark profile-image copies) and aren't referenced
  //     by any bookmark, so they can't be actionable dupes.
  //   excludedFiles — manifest-tracked rendering artifacts that would create
  //     dupe noise: profile images (every same-author bookmark would share
  //     them) and video poster thumbnails (the bookmark surfaces the .mp4
  //     as its main media; the .jpg is a sibling, not a user-facing photo).
  const trackedFiles = new Set();
  const excludedFiles = new Set();
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      for (const e of manifest.entries) {
        if (!e.localPath) continue;
        const filename = basename(e.localPath);
        trackedFiles.add(filename);
        const url = e.sourceUrl || "";
        if (
          url.includes("profile_images") ||
          url.includes("amplify_video_thumb") ||
          url.includes("tweet_video_thumb") ||
          url.includes("ext_tw_video_thumb")
        ) {
          excludedFiles.add(filename);
        }
      }
    } catch {}
  }

  // Hash new images
  const mediaFiles = readdirSync(mediaDir).filter(f => {
    if (excludedFiles.has(f)) return false;
    const ext = "." + f.split(".").pop().toLowerCase();
    return IMAGE_EXTS.has(ext);
  });

  const todo = mediaFiles.filter(f => !cache.hashes[f]);
  if (todo.length > 0) {
    console.log(`Dedup: hashing ${todo.length} images...`);
    const BATCH = 8;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      await Promise.all(batch.map(async (f) => {
        const h = await computeHash(join(mediaDir, f));
        if (h) cache.hashes[f] = h;
      }));
      const done = Math.min(i + BATCH, todo.length);
      if (onProgress) onProgress(done, todo.length);
      if ((i + BATCH) % 200 === 0 || i + BATCH >= todo.length)
        console.log(`  ${done}/${todo.length}`);
    }
  } else {
    console.log("Dedup: image hashes up to date");
  }

  // Find image duplicate groups. The grouping itself is O(N²) Hamming-distance
  // comparisons over ~thousands of hashes — dominant cost of buildDedupCache,
  // and the main reason server startup spent 7s on this. Cache the result keyed
  // by a hash of the filtered files set; reuse when nothing has changed.
  // Filter: prefix is a live bookmark, file is manifest-tracked (drops disk
  // orphans from older naming schemes), and isn't a PFP or video thumb.
  const tweetIdOf = (f) => f.split("-")[0];
  const liveBookmarkIds = new Set((bookmarks || []).map(b => b.id));
  const files = Object.keys(cache.hashes).filter(f => {
    if (colorCache && !isReliableHash(colorCache[f])) return false;
    if (!liveBookmarkIds.has(tweetIdOf(f))) return false;
    if (!trackedFiles.has(f)) return false;
    if (excludedFiles.has(f)) return false;
    return true;
  });
  const imageGroupsKey = createHash("sha256")
    .update(files.slice().sort().join("\n"))
    .digest("hex");

  let imageDupes;
  if (cache.imageGroupsKey === imageGroupsKey && cache.imageDupes) {
    imageDupes = cache.imageDupes;
    console.log(`Dedup: ${files.length} hashes unchanged, reusing ${imageDupes.length} image groups`);
  } else {
    imageDupes = [];
    const visited = new Set();
    for (let i = 0; i < files.length; i++) {
      if (visited.has(files[i])) continue;
      const group = [files[i]];
      for (let j = i + 1; j < files.length; j++) {
        if (visited.has(files[j])) continue;
        if (tweetIdOf(files[j]) === tweetIdOf(files[i])) continue;
        if (hammingDistance(cache.hashes[files[i]], cache.hashes[files[j]]) <= PHASH_THRESHOLD) {
          group.push(files[j]);
          visited.add(files[j]);
        }
      }
      if (group.length > 1) {
        visited.add(files[i]);
        imageDupes.push(group);
      }
    }
  }

  // Find text duplicate groups
  const textMap = new Map();
  if (bookmarks) {
    for (const b of bookmarks) {
      const norm = normalizeText(b.text);
      if (norm.length < 20) continue;
      if (!textMap.has(norm)) textMap.set(norm, []);
      textMap.get(norm).push(b.id);
    }
  }
  const textDupes = [];
  for (const [, ids] of textMap) {
    if (ids.length > 1) textDupes.push(ids);
  }

  atomicWriteFileSync(DEDUP_PATH, JSON.stringify({
    hashes: cache.hashes,
    imageGroupsKey,
    imageDupes,
  }));
  console.log(`Dedup: ${imageDupes.length} image groups, ${textDupes.length} text groups`);
  return { imageDupes, textDupes };
}

export function loadDedupCache() {
  if (!existsSync(DEDUP_PATH)) return { hashes: {} };
  try {
    return JSON.parse(readFileSync(DEDUP_PATH, "utf-8"));
  } catch { return { hashes: {} }; }
}
