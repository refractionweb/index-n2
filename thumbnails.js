// Generate 1200px-wide thumbnails for post media (not pfps), only when the
// source is actually bigger than 1200 px on its longest side. Files at or
// below 1200 px are served directly from ft's media/ directory — no thumb
// file is created. Matches Twitter's `:medium` variant ceiling so today's
// corpus produces zero thumbs; the pipeline activates when ft starts
// fetching larger variants (fieldtheory-cli#153).

import sharp from "sharp";
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

let THUMBS_DIR;

export function setCacheDir(dir) {
  THUMBS_DIR = join(dir, "thumbnails");
}
// THUMB_WIDTH = both the target dim AND the skip threshold. Anything ≤ this
// max-side is served raw; anything larger is resized down to this size on
// the longest side. Single number, one mental model.
const THUMB_WIDTH = 1200;
const THUMB_QUALITY = 80;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function buildThumbnails(ftDir, onProgress) {
  const manifestPath = join(ftDir, "media-manifest.json");
  if (!existsSync(manifestPath)) return new Set();

  if (!existsSync(THUMBS_DIR)) mkdirSync(THUMBS_DIR, { recursive: true });

  // A corrupt manifest shouldn't crash the rebuild — treat it the same as a
  // missing manifest (no thumbs to build this round). dedup.js / colorize.js
  // follow the same try/catch-and-fallback pattern for the manifest read.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    console.warn(`buildThumbnails: media-manifest.json unreadable (${e instanceof Error ? e.message : e}) — skipping`);
    return new Set();
  }
  const mediaDir = join(ftDir, "media");

  // First pass: cheap filter on manifest fields. No I/O per file.
  const candidates = [];
  for (const e of manifest.entries) {
    if (e.status !== "downloaded") continue;
    if (!e.localPath) continue;
    // Skip profile images
    if (e.sourceUrl?.includes("profile_images")) continue;
    const filename = basename(e.localPath);
    const ext = "." + filename.split(".").pop().toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const thumbPath = join(THUMBS_DIR, filename);
    if (existsSync(thumbPath)) continue;
    candidates.push({ src: join(mediaDir, filename), dest: thumbPath, filename });
  }

  // Second pass: only thumb files whose long side exceeds THUMB_WIDTH.
  // sharp().metadata() just reads the JPEG/PNG header — typically ~1 ms per
  // file, well under the cost of an actual resize. Parallel batches keep the
  // pre-check short even on a multi-thousand-file rebuild.
  const todo = [];
  const META_BATCH = 16;
  for (let i = 0; i < candidates.length; i += META_BATCH) {
    const batch = candidates.slice(i, i + META_BATCH);
    const metas = await Promise.all(batch.map(async (c) => {
      try {
        const m = await sharp(c.src).metadata();
        return { c, w: m.width || 0, h: m.height || 0 };
      } catch { return { c, w: 0, h: 0 }; }
    }));
    for (const { c, w, h } of metas) {
      if (Math.max(w, h) > THUMB_WIDTH) todo.push(c);
    }
  }

  if (todo.length === 0) {
    console.log("Thumbnails: nothing new");
    return collectExisting();
  }

  console.log(`Thumbnails: generating ${todo.length}...`);
  let done = 0;
  // Process in parallel batches
  const BATCH = 8;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ src, dest }) => {
      // Sharp's .toFile() streams to disk; a process kill mid-write leaves a
      // truncated JPEG that the existsSync check below won't redo. Write to a
      // sibling .tmp first, then rename — same crash-safety as
      // atomicWriteFileSync but built around sharp's async pipeline.
      const tmp = dest + ".tmp";
      try {
        await sharp(src)
          .resize(THUMB_WIDTH, THUMB_WIDTH, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: THUMB_QUALITY, progressive: true, mozjpeg: true })
          .toFile(tmp);
        renameSync(tmp, dest);
      } catch (e) { /* skip broken; stale .tmp is overwritten next run */ }
    }));
    done += batch.length;
    if (onProgress) onProgress(done, todo.length);
    if (done % 200 === 0 || done === todo.length) {
      console.log(`  ${done}/${todo.length}`);
    }
  }
  console.log("Thumbnails: done");
  return collectExisting();
}

function collectExisting() {
  if (!existsSync(THUMBS_DIR)) return new Set();
  return new Set(readdirSync(THUMBS_DIR));
}
