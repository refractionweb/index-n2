#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, createReadStream, existsSync, statSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { join, resolve, sep, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildColorCache, loadColors, setCacheDir as setColorCacheDir } from "./colorize.js";
import { buildThumbnails, setCacheDir as setThumbsCacheDir } from "./thumbnails.js";
import { buildDedupCache, setCacheDir as setDedupCacheDir } from "./dedup.js";
import { spawn as spawnCmd } from "node:child_process";
import { EventEmitter } from "node:events";
import open from "open";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const CACHE_DIR = join(homedir(), ".index-n2");
setColorCacheDir(CACHE_DIR);
setThumbsCacheDir(CACHE_DIR);
setDedupCacheDir(CACHE_DIR);
const FT = process.env.FT_DATA_DIR || join(homedir(), ".ft-bookmarks");

// Home-relative form of a path ("~/.ft-bookmarks/media") for anything that
// leaves the server as user-copyable text, so exports don't carry the
// account name. Paths outside the home directory are returned unchanged.
function tildify(p) {
  const home = homedir();
  if (p === home) return "~";
  return p.startsWith(home + sep) ? "~" + p.slice(home.length) : p;
}
// Default port avoids the notorious 3000 collision (Next.js, Grafana, Rails,
// etc). `PORT=` env pins explicitly and disables the auto-increment fallback
// below — if the user asks for a specific port they want to know when it fails.
let PORT = Number(process.env.PORT) || 5787;
const PORT_PINNED = !!process.env.PORT;
const SETTINGS_PATH = join(CACHE_DIR, "settings.json");

// Settings schema. Defaults are authoritative — loaded settings are merged on
// top so old files without new keys stay valid.
const DEFAULT_SETTINGS = Object.freeze({
  autoplayVideos: true,
  // 0 means "no limit" — ft fetch-media runs without --limit (Infinity in
  // bookmark-media.ts since ft 1.3.13). Matches ft's own default. Only applies
  // to the Fetch Media button; ft sync has no --limit flag, so Sync's internal
  // media phase ignores this setting entirely (controlled by skipMedia instead).
  mediaFetchLimit: 0,
  skipProfileImages: false,
  // When true, Sync passes --no-media to ft sync — bookmarks-only run, no
  // inline media fetch. User clicks Fetch Media separately to download media.
  // Default false: ft sync's auto-media (Infinity since 1.3.18) handles it
  // inline, no extra click needed.
  skipMedia: false,
  autoOpenBrowser: true,
  theme: "system",
  // Suppresses the "files will be re-downloaded" confirmation when cancelling
  // an in-flight `ft fetch-media`. UI-only, but lives here so a single Reset
  // to Defaults clears it alongside the rest, and the choice survives a
  // browser-data clear.
  cancelMediaWarningSuppressed: false,
  // Suppresses the "no batch limit set — fetch may take a while" warning
  // shown before Sync (skipMedia off) and Fetch Media (mediaFetchLimit 0).
  // One flag for both surfaces — user only needs to dismiss the unbounded-
  // fetch concept once.
  noLimitWarningSuppressed: false,
  // When true, the home / archive / gallery hide bookmarks where any
  // post media OR quoted-tweet media item hasn't been downloaded yet
  // (placeholder cross visible). Off by default — placeholders preserve
  // layout slot for pending media. Useful when you've synced a large
  // batch and don't want a wall of empty cards while waiting on `ft
  // fetch-media`. Pfp is excluded from the check — `skipProfileImages`
  // is a legitimate user choice, hiding bookmarks for a setting-driven
  // absence would be wrong.
  hideUnfetched: false,
});

let settingsCache = null;
function getSettings() {
  if (settingsCache) return settingsCache;
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    settingsCache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache;
}

// Partial merge; invalid/unknown keys get dropped by re-merging onto defaults.
// Builds `merged` from scratch over DEFAULT_SETTINGS keys (rather than spreading
// `current` first) so unknown keys carried over from older versions get stripped
// on every save. Self-healing migration — no separate cleanup pass needed.
function saveSettings(patch) {
  const current = getSettings();
  const merged = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const defaultVal = DEFAULT_SETTINGS[key];
    const incoming = patch[key];
    merged[key] = (key in patch && typeof incoming === typeof defaultVal)
      ? incoming
      : (current[key] ?? defaultVal);
  }
  // Sanity-check mediaFetchLimit: non-negative integer. 0 means "no limit"
  // (ft fetch-media without --limit). User can cancel mid-flight via the
  // sidebar Cancel button if an unbounded run takes longer than intended.
  // Falls back to the default on NaN/Infinity/negative.
  if (typeof merged.mediaFetchLimit === "number") {
    const n = Math.round(merged.mediaFetchLimit);
    merged.mediaFetchLimit = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.mediaFetchLimit;
  }
  settingsCache = merged;
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  // Recount unfetched + push to any open SSE consumers. Cheap and unconditional —
  // most settings don't affect the count, but the only setting that does
  // (`skipProfileImages`) would otherwise leave the badge stale until the next
  // sync. Generic recompute beats remembering which keys are count-relevant.
  unfetchedCount = computeUnfetchedTotal();
  emitSync();
  return merged;
}

let colorCache = loadColors();
let thumbsSet = new Set();
let dedupResult = { imageDupes: [], textDupes: [] };

// --- Category enrichment (read-only SQLite) ---
// ft classify stores `primary_category` + comma-separated `categories` in
// ~/.ft-bookmarks/bookmarks.db. We open it read-only via sql.js-fts5 (the same
// WASM build the CLI uses, so its FTS5 virtual tables don't fail to open) and
// cache the map keyed by bookmark id. Refreshed when the db mtime changes.
const requireCjs = createRequire(import.meta.url);
let sqlPromise = null;
function getSqlJs() {
  if (!sqlPromise) {
    const initSqlJs = requireCjs("sql.js-fts5");
    const wasmPath = requireCjs.resolve("sql.js-fts5/dist/sql-wasm.wasm");
    const wasmBinary = readFileSync(wasmPath);
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}

// id -> { primary, categories, article: { title, text } | null }
// Article enrichment is filtered downstream in loadBookmarks — set on the
// Bookmark only when the outer link is an X Article (`/i/article/<id>`).
// ft populates article_* for any URL it scrapes (YouTube, GitHub, etc.),
// so the URL filter is what makes the field meaningfully "this is the
// X Article preview" rather than "ft enriched something."
let categoryCache = new Map();
let categoryCacheMtime = 0;
// Tracks whether loadCategories has completed at least one successful pass.
// Using a boolean (not `categoryCache.size > 0`) so a legitimately empty
// bookmarks table — fresh install, pre-first-sync — doesn't re-read the
// SQLite buffer on every /api/bookmarks call. Also future-proofs the cache
// against any loop-level filtering that might leave the cache empty by
// design (e.g., skipping unclassified rows).
let categoryCacheLoaded = false;

async function loadCategories() {
  const dbPath = join(FT, "bookmarks.db");
  if (!existsSync(dbPath)) {
    categoryCache = new Map();
    categoryCacheMtime = 0;
    categoryCacheLoaded = false;
    return;
  }
  const mtime = statSync(dbPath).mtimeMs;
  if (mtime === categoryCacheMtime && categoryCacheLoaded) return;

  const SQL = await getSqlJs();
  const buf = readFileSync(dbPath);
  let db;
  try {
    db = new SQL.Database(buf);
    const rows = db.exec(
      "SELECT id, primary_category, categories, article_title, article_text FROM bookmarks"
    );
    const next = new Map();
    if (rows.length > 0) {
      for (const [id, primary, categories, articleTitle, articleText] of rows[0].values) {
        next.set(id, {
          primary: primary && primary !== "unclassified" ? primary : null,
          categories: categories
            ? String(categories).split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          article:
            articleTitle && articleText
              ? { title: String(articleTitle), text: String(articleText) }
              : null,
        });
      }
    }
    categoryCache = next;
    categoryCacheMtime = mtime;
    categoryCacheLoaded = true;
  } catch (err) {
    // Corrupt db ("database disk image is malformed") or an older ft schema
    // missing the primary_category / categories / article_* columns ("no such
    // column"). Degrade to no categories rather than 500-ing /api/bookmarks,
    // which would blank the whole UI. Stamp mtime+loaded so the same bad db
    // isn't reopened on every request.
    console.warn(`bookmarks.db categories unreadable, ignoring: ${err.message}`);
    categoryCache = new Map();
    categoryCacheMtime = mtime;
    categoryCacheLoaded = true;
  } finally {
    db?.close();
  }
}

// Resolve a request path under `base` and refuse paths that escape it (path
// traversal + symlink escape). Two-step check:
//   1. Lexical: resolve(base, segment) must lie under resolve(base).
//      Catches `../../../etc/passwd`-style traversal.
//   2. Symlink: realpath(full) must lie under realpath(base). Closes the gap
//      where step 1 alone passes a symlink that lexically looks safe but
//      points outside (e.g., a symlink inside ~/.ft-bookmarks/media/ that
//      targets /etc/). createReadStream follows symlinks; the lexical check
//      doesn't, so without this we'd serve the symlink target.
// ENOENT during realpath means the file doesn't exist — return the lexical
// path so the caller's existsSync check 404s naturally.
//
// Trade-off worth knowing about: a legitimately-placed symlink pointing
// outside `base` (e.g., `~/.ft-bookmarks/media/external -> /Volumes/BigDisk`
// for storage offload) will also 403. ft itself doesn't use external storage
// today, so this is theoretical — but if a power user reports "my external-
// drive media doesn't load," this is the rule rejecting it.
function safeJoin(base, reqSegment) {
  let decoded;
  try { decoded = decodeURIComponent(reqSegment); } catch { return null; }
  const full = resolve(base, decoded);
  const baseResolved = resolve(base) + sep;
  if (full !== resolve(base) && !full.startsWith(baseResolved)) return null;
  try {
    const realFull = realpathSync(full);
    const realBase = realpathSync(base);
    if (realFull !== realBase && !realFull.startsWith(realBase + sep)) return null;
    return realFull;
  } catch (e) {
    if (e.code === "ENOENT") return full;
    return null;
  }
}

// Reject cross-origin requests to mutating endpoints. Browsers send Origin on
// every cross-origin fetch/XHR and on same-origin fetch from our SPA — if a
// page at evil.com pokes our localhost API, Origin reveals it. Origin-only
// (no Referer fallback): Referer is strippable by proxies and overwritten by
// some redirects, so it's a less reliable signal — the API is browser-fetch
// only, where Origin is always present. Absent Origin = treated as untrusted
// for writes (curl/extensions hit safe-read endpoints or pass
// --header "Origin: http://localhost:<port>").
//
// Exact-origin match (scheme+host+port), not hostname-only: any other local
// app — a dev server, a notebook, a page XSS'd on some other port — is a
// different origin and must not write. The vite dev client (5173) is
// allowlisted: `npm run dev` proxies /api here but forwards the browser's
// real Origin. That forwarding is also what stops a third page from
// laundering writes through the proxy — it would still present its own
// Origin, not 5173's.
function isSameOrigin(req) {
  const source = req.headers.origin;
  if (!source) return false;
  return (
    source === `http://localhost:${PORT}` ||
    source === `http://127.0.0.1:${PORT}` ||
    source === "http://localhost:5173" ||
    source === "http://127.0.0.1:5173"
  );
}

function requireSameOrigin(req, res) {
  if (isSameOrigin(req)) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end('{"error":"forbidden"}');
  return false;
}

// DNS-rebinding defense: a page at evil.com whose DNS is rebound to
// 127.0.0.1 reaches this server with requests the browser considers
// same-origin — no CORS, fully readable responses. Binding to loopback
// doesn't help; the connection genuinely arrives on 127.0.0.1, with
// Host: evil.com. Requiring a loopback hostname in Host kills the class
// (same defense as Vite's allowedHosts). Hostname only — the port is
// ignored because the vite dev proxy forwards the browser's Host
// (localhost:5173) untouched.
function requireAllowedHost(req, res) {
  const host = req.headers.host;
  if (host) {
    try {
      const { hostname } = new URL(`http://${host}`);
      if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    } catch {
      // unparseable Host → fall through to 403
    }
  }
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end('{"error":"forbidden host"}');
  return false;
}

// Apply default security headers to every response. CSP bounds what the SPA is
// allowed to load; everything is same-origin (Vite bundles JS/CSS/fonts into
// dist/, API and media all go through this server). The inline script-src hash
// covers index.html's FOUC-avoidance <script> which must run before the React
// bundle loads. 'unsafe-inline' on style-src covers shadcn chart's <style>
// dangerouslySetInnerHTML block and React inline style={} attributes.
// Computed at startup from dist/index.html; change → rebuild + restart.
function computeInlineScriptHashes() {
  const indexPath = join(__dirname, "dist", "index.html");
  if (!existsSync(indexPath)) return [];
  try {
    const html = readFileSync(indexPath, "utf-8");
    const hashes = [];
    // Match inline <script> (no src attribute) blocks verbatim. Hash must be
    // computed over the exact bytes between the opening and closing tags.
    const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const hash = createHash("sha256").update(m[1]).digest("base64");
      hashes.push(`'sha256-${hash}'`);
    }
    return hashes;
  } catch { return []; }
}

const INLINE_SCRIPT_HASHES = computeInlineScriptHashes();

const CSP = [
  "default-src 'self'",
  `script-src 'self'${INLINE_SCRIPT_HASHES.length ? " " + INLINE_SCRIPT_HASHES.join(" ") : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CSP);
}

// Range of fieldtheory-cli versions index-n2 has been tested against. Both
// bounds inclusive. Starts with min === max (single tested version); expand
// `max` upward as new ft releases get verified.
//
// Detected ft outside this range:
//   - older than `min` → "outdated", sync controls disabled (we know flags
//     we depend on don't exist)
//   - newer than `max` → "untested", sync controls enabled with a warning
//     badge (probably works, but we haven't verified)
const FT_TESTED = Object.freeze({ min: "1.3.19", max: "1.3.19" });

// Three-segment numeric version compare. Returns negative / zero / positive
// in the usual sort-order convention. Tolerates missing trailing segments
// ("1.3" === "1.3.0"). Falls back to treating unparseable input as 0 — so
// a corrupt fieldtheory package.json defaults to "compatible" rather than
// throwing and crashing /api/info.
function compareVersion(a, b) {
  const parse = (s) => String(s ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Map an ft version string to one of three states. Returns null when ft
// itself isn't detected (caller passes null version through).
function ftStatus(version) {
  if (!version) return null;
  if (compareVersion(version, FT_TESTED.min) < 0) return "outdated";
  if (compareVersion(version, FT_TESTED.max) > 0) return "untested";
  return "compatible";
}

// Detect the installed fieldtheory CLI version by reading its package.json
// directly. Bypasses the `ft --version` bug (hardcoded string until v1.3.5,
// commit 786cbfe6) — accurate even on outdated installs. Returns null if ft
// can't be found, which the About card surfaces as "not detected".
//
// Two strategies, in order:
//   1) Node module resolution from this server's perspective. Works when the
//      GUI and ft are siblings under npm-global lib/node_modules.
//   2) PATH lookup → realpath the binary → walk up looking for package.json.
//      Covers homebrew, nvm, manual installs, anything that puts `ft` on PATH.
function detectFtVersion() {
  try {
    const pkgPath = requireCjs.resolve("fieldtheory/package.json");
    const meta = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (meta?.name === "fieldtheory" && typeof meta.version === "string") {
      return { version: meta.version };
    }
  } catch {}

  try {
    const PATH = process.env.PATH || "";
    const pathSep = process.platform === "win32" ? ";" : ":";
    const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    let ftBin = null;
    outer: for (const dir of PATH.split(pathSep)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = join(dir, "ft" + ext);
        if (existsSync(candidate)) { ftBin = candidate; break outer; }
      }
    }
    if (!ftBin) return null;
    let dir = dirname(realpathSync(ftBin));
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const meta = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (meta?.name === "fieldtheory" && typeof meta.version === "string") {
            return { version: meta.version };
          }
        } catch {}
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}

  return null;
}

// Strip a trailing self-link URL from a bookmark's text when the bookmark
// has a quoted tweet. Twitter appends the quoted tweet's URL to the text in
// the extended-text format; X's web UI hides it because the quote card
// already represents the target. Two trailing forms appear in our data: raw
// `https://t.co/xxx` (the common case) and display-form `x.com/<handle>/...`
// with an optional `…` ellipsis (when ft expanded the t.co at sync time).
// Gating on `hasQuotedTweet` is essential — for non-quote bookmarks a
// trailing URL is typically a media self-link that should stay in the text.
function stripTrailingQuoteSelfLink(text, hasQuotedTweet) {
  if (!hasQuotedTweet || !text) return text;
  return text
    .replace(/\s*(?:https?:\/\/t\.co\/\S+|(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/\S+)\s*$/, "")
    .trim();
}

// --- Build bookmarks JSON with local media paths ---
function loadBookmarks() {
  const jsonlPath = join(FT, "bookmarks.jsonl");
  // Treat missing file as "0 bookmarks synced yet" — matches the graceful-skip
  // pattern used by loadCategories, computeUnfetchedTotal, runRebuild, etc.
  // Without this, a fresh `npm i -g` install (no `ft sync` ever run) hits a
  // 500 on /api/bookmarks instead of the empty-state UI.
  if (!existsSync(jsonlPath)) return [];
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split(/\n(?=\{)/);

  // Build media map: sourceUrl -> local filename
  const mediaMap = new Map();
  const manifestPath = join(FT, "media-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      for (const e of manifest.entries || []) {
        if (e.status === "downloaded" && e.localPath) {
          const filename = basename(e.localPath);
          mediaMap.set(e.sourceUrl, filename);
        }
      }
    } catch (err) {
      // Corrupt/truncated manifest (manual edits, interrupted cloud-sync, bad
      // sectors) or a valid-but-shapeless `{}` — degrade to "no media mapped"
      // rather than 500-ing /api/bookmarks and, via rebuildCaches, crashing the
      // startup rebuild. Mirrors the guarded manifest reads in colorize.js /
      // dedup.js / thumbnails.js / computeUnfetchedTotal.
      console.warn(`media-manifest.json unreadable, ignoring: ${err.message}`);
    }
  }

  // Build a MediaItem array from a source with mediaObjects. Used for the main
  // bookmark and its quotedTweet — both have identical shape, both go through
  // ft fetch-media (1.3.13+), both land in the same ~/.ft-bookmarks/media/.
  // For video items, ft's graphql parser sets `m.url` to the poster image URL
  // (pbs.twimg.com/amplify_video_thumb/...) and mp4 URLs live on
  // `m.videoVariants[].url`. Both get fetched by ft and tracked in mediaMap,
  // so the mp4 and the poster are independent lookups against the same map.
  // Quoted-tweet posters are shared across every bookmark that quotes the
  // same tweet because ft's manifest is sourceUrl-keyed (one file per URL).
  // `thumb` always points at a real file when one exists — the 1200 px cached
  // rendition if it was generated, otherwise the original. The frontend's
  // `media.thumb ?? media.url` fallback becomes a no-op in the happy path.
  const buildMedia = (source) => {
    return (source.mediaObjects || []).map(m => {
      if ((m.type === "video" || m.type === "animated_gif") && Array.isArray(m.videoVariants)) {
        const sorted = m.videoVariants
          .filter(v => v.url)
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        for (const v of sorted) {
          const local = mediaMap.get(v.url);
          if (local) {
            const posterLocal = mediaMap.get(m.url);
            const thumb = posterLocal
              ? (thumbsSet.has(posterLocal) ? `/thumbs/${posterLocal}` : `/media/${posterLocal}`)
              : null;
            return {
              type: m.type,
              url: `/media/${local}`,
              thumb,
              width: m.width,
              height: m.height,
              colors: posterLocal ? (colorCache[posterLocal] || null) : null,
            };
          }
        }
      }
      const local = mediaMap.get(m.url);
      if (local) {
        return {
          type: m.type,
          url: `/media/${local}`,
          thumb: thumbsSet.has(local) ? `/thumbs/${local}` : `/media/${local}`,
          width: m.width,
          height: m.height,
          colors: colorCache[local] || null,
        };
      }
      // Source data has the media item but no file is on disk (no variant
      // for video, no source url for photo). Return a placeholder so the
      // client can reserve the right slot in the layout and render a
      // gray-with-cross marker instead of dropping the item entirely.
      // Heights stay correct because width/height come from the source
      // metadata; they only become null in the rare case where the source
      // data itself lacks dimensions.
      return {
        type: m.type,
        url: null,
        thumb: null,
        width: m.width || null,
        height: m.height || null,
        colors: null,
      };
    });
  };

  // Per-line try/catch so one corrupted line doesn't blank the entire grid.
  // Truncated writes, encoding glitches, mid-append crashes, manual edits —
  // any of them throw from JSON.parse. Without this guard, a single bad line
  // collapses /api/bookmarks to a 500. Mirrors computeUnfetchedTotal's pattern
  // (server.js:500-509). Skipped lines tally is logged once per load so
  // corruption is visible without spamming on every iteration. The first
  // bad line's error + a 200-char snippet are captured so a "skipped 47
  // lines" report is debuggable from the server log alone.
  const bookmarks = [];
  let skipped = 0;
  let firstBad = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line);

      const media = buildMedia(b);

      const pfpKey = b.authorProfileImageUrl?.replace("_normal.", "_400x400.");
      const pfpFile = pfpKey ? mediaMap.get(pfpKey) : null;

      const cats = categoryCache.get(b.id);
      // Expose article enrichment ONLY when the outer link is an X Article
      // (`/i/article/<id>`). ft populates article_* for any scraped URL
      // (YouTube, GitHub, product pages, etc.) — the URL filter narrows
      // this to the "X Article preview card" UX bucket. Other enrichments
      // stay in SQLite, unused here.
      const isXArticle =
        Array.isArray(b.links) &&
        b.links.some((l) => typeof l === "string" && l.includes("/i/article/"));
      const article = isXArticle ? cats?.article ?? null : null;
      bookmarks.push({
        _order: bookmarks.length,
        id: b.id,
        url: b.url,
        text: stripTrailingQuoteSelfLink(b.text, !!b.quotedTweet),
        authorHandle: b.authorHandle,
        authorName: b.authorName,
        pfp: pfpFile ? `/media/${pfpFile}` : null,
        postedAt: b.postedAt,
        bookmarkedAt: b.bookmarkedAt,
        syncedAt: b.syncedAt ?? null,
        language: b.language,
        links: b.links,
        engagement: b.engagement,
        media,
        primary_category: cats?.primary ?? null,
        categories: cats?.categories ?? [],
        article,
        isThread: !!(b.tweetId && b.conversationId && b.tweetId !== b.conversationId),
        // Surfaced for the orphan-quote placeholder: when set without
        // `quotedTweet` populated, the GUI renders "This post is unavailable."
        // in the quote slot. See QuotedTweetCard.
        quotedStatusId: b.quotedStatusId ?? null,
        quotedTweet: b.quotedTweet ? (() => {
          const q = b.quotedTweet;
          const pfpKey = q.authorProfileImageUrl?.replace("_normal.", "_400x400.");
          const pfpFile = pfpKey ? mediaMap.get(pfpKey) : null;
          // Strip trailing t.co self-link (no `links` map available for quotes)
          const text = (q.text || "").replace(/\s*https:\/\/t\.co\/\S+$/, "").trim();
          return {
            // Tweet id surfaced so the GUI can check `byId.get(quote.id)` — when
            // the quoted tweet is itself a bookmark, click opens its lightbox
            // in-app instead of navigating to X.
            id: q.id,
            text,
            url: q.url,
            authorHandle: q.authorHandle,
            authorName: q.authorName,
            postedAt: q.postedAt,
            // Match main-author behavior: null when not local. CLI 1.3.13+ fetches
            // quoted-tweet pfps via resolveMediaTargets, so they land in /media/
            // on the next sync. Pre-1.3.13 the field stays null until upgrade.
            pfp: pfpFile ? `/media/${pfpFile}` : null,
            // Same buildMedia helper as the outer bookmark — quoted tweets carry
            // mediaObjects identically and ft 1.3.13+ fetches them into the
            // same /media/ directory. Sharing across bookmarks-that-quote is
            // handled by ft's manifest being sourceUrl-keyed (one local file
            // per unique URL), so identical poster URLs collapse naturally.
            media: buildMedia(q),
          };
        })() : undefined,
      });
    } catch (e) {
      skipped++;
      if (!firstBad) {
        firstBad = {
          msg: e instanceof Error ? e.message : String(e),
          snippet: line.slice(0, 200),
          truncated: line.length > 200,
        };
      }
    }
  }
  if (skipped > 0) {
    console.warn(`loadBookmarks: skipped ${skipped} malformed line(s) in bookmarks.jsonl`);
    if (firstBad) console.warn(`  first bad line: ${firstBad.msg} — ${firstBad.snippet}${firstBad.truncated ? "…" : ""}`);
  }
  return bookmarks;
}

let cachedBookmarks = null;
let cachedMtime = 0;
let unfetchedCount = 0;

// Per-asset cap that ft considers "I have this asset" for skipped_too_large
// entries (bookmark-media.ts: DEFAULT_MEDIA_MAX_BYTES). Anything bigger is
// recorded with status: skipped_too_large + bytes > max, which ft treats as
// covered. Mirror that here so the unfetched count agrees.
const DEFAULT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

// Mirror of `ft fetch-media`'s target extraction (bookmark-media.ts
// resolveMediaTargets, CLI ≥1.3.13). Returns {tweetId, sourceUrl,
// isProfileImage} so the unfetched-count check can match ft's covered-key
// shape: pfps are deduped globally by URL (`profile::${sourceUrl}`), other
// assets by (tweetId, sourceUrl). tweetId is the inner source's id —
// bookmark.tweetId for outer media, bookmark.quotedTweet.id for quoted.
//
// For video / animated_gif media objects ft pushes BOTH the preview poster
// AND the highest-bitrate mp4; we replicate that or the count drifts from
// ft's view of the manifest.
function appendMediaTargets(targets, seenKeys, source, coveredProfileImageUrls, skipProfileImages) {
  if (!source) return;
  const tweetId = source.tweetId;
  const push = (sourceUrl, isProfileImage) => {
    if (!sourceUrl) return;
    const key = isProfileImage ? `profile::${sourceUrl}` : `${tweetId}::${sourceUrl}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    targets.push({ tweetId, sourceUrl, isProfileImage });
  };
  if (source.mediaObjects?.length) {
    for (const mo of source.mediaObjects) {
      const previewUrl = mo.previewUrl ?? mo.url ?? mo.mediaUrl;
      if (mo.type === "video" || mo.type === "animated_gif") {
        push(previewUrl, false);
        const mp4s = (mo.videoVariants ?? mo.variants ?? [])
          .filter(v => v.url && (!v.contentType || v.contentType === "video/mp4"))
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        push(mp4s[0]?.url, false);
        continue;
      }
      push(previewUrl, false);
    }
  } else {
    for (const u of source.media ?? []) push(u, false);
  }
  if (source.authorProfileImageUrl && !skipProfileImages) {
    const fullUrl = source.authorProfileImageUrl.replace("_normal.", "_400x400.");
    if (!coveredProfileImageUrls.has(fullUrl)) push(fullUrl, true);
  }
}

function resolveMediaTargets(b, coveredProfileImageUrls, skipProfileImages) {
  const targets = [];
  const seenKeys = new Set();
  appendMediaTargets(targets, seenKeys, {
    tweetId: b.tweetId,
    media: b.media,
    mediaObjects: b.mediaObjects,
    authorProfileImageUrl: b.authorProfileImageUrl,
  }, coveredProfileImageUrls, skipProfileImages);
  if (b.quotedTweet) {
    appendMediaTargets(targets, seenKeys, {
      tweetId: b.quotedTweet.id,
      media: b.quotedTweet.media,
      mediaObjects: b.quotedTweet.mediaObjects,
      authorProfileImageUrl: b.quotedTweet.authorProfileImageUrl,
    }, coveredProfileImageUrls, skipProfileImages);
  }
  return targets;
}

// Count distinct media targets ft considers pending. Mirrors `ft fetch-media`'s
// candidate logic (bookmark-media.ts hasPendingMediaTarget + isCoveredEntry)
// so the sidebar's "N unfetched" badge reflects ft's actual pending set —
// not GUI's per-bookmark pfp accounting, which over-counted ~40× (2,839 vs
// ft's 62 on the same data) because a single covered author pfp shows up
// as 1 manifest entry but N bookmark slots.
//
// Covered = downloaded OR (skipped_too_large AND bytes > maxBytes). Failed
// entries are NOT covered: ft has no permanent-failure backoff and retries
// them every run. They count as pending here too.
function computeUnfetchedTotal() {
  const jsonlPath = join(FT, "bookmarks.jsonl");
  const manifestPath = join(FT, "media-manifest.json");
  if (!existsSync(jsonlPath)) return 0;

  const coveredAssetKeys = new Set();
  const coveredProfileImageUrls = new Set();
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      for (const e of manifest.entries || []) {
        const isCovered =
          e.status === "downloaded" ||
          (e.status === "skipped_too_large" && typeof e.bytes === "number" && e.bytes > DEFAULT_MEDIA_MAX_BYTES);
        if (!isCovered || !e.sourceUrl) continue;
        if (e.sourceUrl.includes("/profile_images/")) {
          coveredProfileImageUrls.add(e.sourceUrl);
        } else if (e.tweetId) {
          coveredAssetKeys.add(`${e.tweetId}::${e.sourceUrl}`);
        }
      }
    } catch (e) {
      console.warn(
        `computeUnfetchedTotal: media-manifest.json unreadable, treating as empty coverage: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const skipProfileImages = getSettings().skipProfileImages;
  const pendingKeys = new Set();
  const raw = readFileSync(jsonlPath, "utf-8").split(/\n(?=\{)/);
  // Per-line skip mirrors loadBookmarks; aggregate count so corruption surfaces
  // in logs without per-iteration spam.
  let skipped = 0;
  for (const line of raw) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line);
      for (const t of resolveMediaTargets(b, coveredProfileImageUrls, skipProfileImages)) {
        const key = t.isProfileImage ? `profile::${t.sourceUrl}` : `${t.tweetId}::${t.sourceUrl}`;
        if (t.isProfileImage || !coveredAssetKeys.has(key)) pendingKeys.add(key);
      }
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.warn(`computeUnfetchedTotal: skipped ${skipped} malformed line(s) in bookmarks.jsonl`);
  }
  return pendingKeys.size;
}

// All sync-UI status strings live here. Two shapes:
//   Transition: "Verb-ing object..." (capitalized, ends with `...`). No counts.
//   Progress:   "{count}[/{total}] {noun} {past-participle}". Number first.
// Add new phases here rather than inline at call sites so the contract holds.
const STATUS = {
  starting:             "Starting...",
  syncingBookmarks:     "Syncing bookmarks...",
  fetchingMedia:        "Fetching media...",
  fillingGaps:          "Filling gaps...",
  indexing:             "Indexing...",
  buildingCaches:       "Building caches...",
  newBookmarksDetected: "New bookmarks detected...",
  // Failure lines. Stored in `syncError` (not `syncStep`, which the rebuild
  // phase overwrites) and shown in the idle sidebar until the next run.
  // spawnError covers libuv spawn failures (ft binary missing or non-
  // executable); without the error handler in run(), an uncaught 'error'
  // event from spawn crashes the server outright — Node has no default
  // uncaughtException trap here.
  spawnError: (code) =>
    code === "ENOENT" ? "ft: command not found" :
    code === "EACCES" ? "ft: permission denied" :
    `ft: spawn failed (${code || "unknown"})`,
  // `label` is the subcommand as typed, e.g. "ft sync --gaps".
  exitError:   (label, code, signal) =>
    signal ? `${label}: terminated (${signal})` : `${label}: exited with code ${code}`,
  idleKilled:  (label) => `${label}: no output for 5 min, stopped`,
  pipelineError: "Sync failed. See server log.",
  newBookmarks:    (n)              => `${n} new bookmarks`,
  // Media-phase live progress. ft's spinner emits "N processed │ M downloaded";
  // we surface the two outcome counts directly — downloaded and failed
  // (failed derived as processed - downloaded). Mirrors ft's own end-of-run
  // summary shape ("✓ M downloaded / K failed") and lets the user see failure
  // rate live without doing the subtraction.
  //
  // Returns null when nothing has resolved yet (processed == 0 OR all
  // outcomes still pending) so the caller keeps the prior "Fetching media..."
  // label instead of rendering an empty status. Skipped-too-large is rolled
  // into `failed` here — under ~1% of runs hit it, and the spinner doesn't
  // expose the breakdown anyway; strict accounting would need to parse the
  // final summary lines.
  mediaProgress:   (processed, downloaded) => {
    const failed = Math.max(0, processed - downloaded);
    const lines = [];
    if (downloaded > 0) lines.push(`${downloaded} downloaded`);
    if (failed > 0)     lines.push(`${failed} failed`);
    return lines.length > 0 ? lines.join("\n") : null;
  },
  cacheProgress:   (done, total, n) => `${done}/${total} ${n}`,
  // Multi-line progress for `ft sync --gaps`. Headline first (matches the
  // X/Y regex the client uses to compute progress %), breakdown lines
  // below — each non-zero counter is one line. Joined by \n; the sidebar
  // splits and renders each line in the same style. Skipped categories
  // (zero counts) drop out so the panel doesn't carry empty noise.
  //
  // Headline says "records checked" rather than "gaps filled" because ft's
  // `done` counter increments per processed tweet id regardless of whether
  // anything actually changed. A common case: a record flagged as "maybe
  // truncated" where ft fetches it and finds the text is already complete
  // — graphqlSettled marks the record so it won't be re-checked, but no
  // category counter (quoted / expanded / articles / failed) increments.
  // "Checked" is the honest verb for that state; "filled" overpromises.
  gapsProgress:    (done, total, breakdown) => {
    const lines = [`${done}/${total} records checked`];
    if (breakdown.quoted)   lines.push(`${breakdown.quoted} quoted tweets recovered`);
    if (breakdown.expanded) lines.push(`${breakdown.expanded} truncated texts expanded`);
    if (breakdown.articles) lines.push(`${breakdown.articles} articles fetched`);
    if (breakdown.failed)   lines.push(`${breakdown.failed} unavailable`);
    return lines.join("\n");
  },
};

// Noun phrases passed to STATUS.cacheProgress — past-participle baked in so
// the rendered string reads as "{X}/{Y} {what} {happened to it}".
const CACHE_NOUN = {
  imageColors: "image colors scanned",
  thumbnails:  "thumbnails rendered",
  imageHashes: "image hashes computed",
};

async function rebuildCaches() {
  const mediaDir = join(FT, "media");
  const manifestPath = join(FT, "media-manifest.json");
  if (existsSync(mediaDir)) {
    const progress = (noun) => (done, total) => {
      if (syncStep !== null) { syncStep = STATUS.cacheProgress(done, total, noun); emitSync(); }
    };
    colorCache = Object.assign(colorCache, await buildColorCache(mediaDir, manifestPath, progress(CACHE_NOUN.imageColors)));
    thumbsSet = await buildThumbnails(FT, progress(CACHE_NOUN.thumbnails));
    const bookmarks = loadBookmarks();
    dedupResult = await buildDedupCache(mediaDir, manifestPath, bookmarks, colorCache, progress(CACHE_NOUN.imageHashes));
  }
  cachedBookmarks = null;
  unfetchedCount = computeUnfetchedTotal();
}

let syncRunning = false;
let syncStep = null;
// Live ft child process for the current /api/sync run (null when in rebuild
// phase or idle). Presence is the source of truth for whether cancel is
// actionable — exposed to the UI as `canCancel`. Set at spawn time in run(),
// cleared when the process emits 'close'.
let activeProc = null;
// Latches to true when /api/sync/cancel fires, checked between pipeline phases
// so a cancel during `ft sync` skips the subsequent `ft fetch-media`. Reset
// to false at the top of each /api/sync run.
let cancelRequested = false;
// Failure line from the last /api/sync run (one of the STATUS failure
// lines), or null. Cleared when the next run starts. A user cancel is not a
// failure.
let syncError = null;
const syncEvents = new EventEmitter();
// Each open /api/sync-stream (SSE) connection attaches one "update" listener,
// detached on close (see the /api/sync-stream handler). Many tabs — or an
// EventSource reconnect storm — can briefly hold >10, tripping Node's default
// listener-leak warning even though nothing leaks. Raise the ceiling so the
// false positive stays out of the console; real leaks would still climb past 50.
syncEvents.setMaxListeners(50);
// One shape for the SSE stream, its initial frame, and /api/sync-status.
function syncSnapshot() {
  return {
    running: syncRunning,
    step: syncStep,
    unfetchedCount,
    canCancel: !!activeProc,
    error: syncError,
  };
}

function emitSync() {
  syncEvents.emit("update", syncSnapshot());
}

// Single in-flight rebuild promise. All callers share it so startup / /api/sync /
// mtime-change cannot overlap or trigger duplicate work.
let activeRebuild = null;
function runRebuild(stepLabel) {
  // Set label BEFORE the dedup guard so it always wins, even when an active
  // rebuild is already in flight. Otherwise the new caller's label is lost.
  if (stepLabel) { syncStep = stepLabel; emitSync(); }
  if (activeRebuild) return activeRebuild;
  // Only claim/release syncRunning when nothing else owns it. The mtime-change
  // path (getBookmarks → here) can fire mid-sync; if it cleared syncRunning on
  // .finally while ft sync was still alive, a second Sync All would slip past
  // the guard at /api/sync and spawn a duplicate ft subprocess.
  const ownsRunning = !syncRunning;
  if (ownsRunning) syncRunning = true;
  activeRebuild = rebuildCaches()
    .catch((err) => {
      // Cache rebuild is best-effort — colors/dedup/thumbnails regenerate on
      // the next trigger. Swallow+log so a rejection from any bare caller
      // (startup at boot, mtime-change in getBookmarks) can't surface as an
      // unhandled rejection and exit the daemon (no global trap).
      console.error("cache rebuild failed:", err);
    })
    .finally(() => {
      activeRebuild = null;
      if (ownsRunning) syncRunning = false;
      syncStep = null;
      cachedBookmarks = null;
      emitSync();
    });
  return activeRebuild;
}

async function getBookmarks() {
  const jsonlPath = join(FT, "bookmarks.jsonl");
  const mtime = existsSync(jsonlPath) ? statSync(jsonlPath).mtimeMs : 0;
  // Refresh the category cache on every call — the internal mtime check makes
  // this near-free when the db hasn't changed. Keeps `primary_category` /
  // `categories` in the response fresh after `ft classify` runs without
  // needing manual cache invalidation.
  const prevCategoryMtime = categoryCacheMtime;
  await loadCategories();
  const categoriesChanged = categoryCacheMtime !== prevCategoryMtime;
  if (!cachedBookmarks || mtime !== cachedMtime || categoriesChanged) {
    const changed = cachedMtime !== 0 && mtime !== cachedMtime;
    cachedBookmarks = loadBookmarks();
    cachedMtime = mtime;
    // Skip the redundant rebuild trigger when /api/sync already owns the
    // pipeline — its IIFE rebuilds at the end anyway. Avoids doing the same
    // work twice on warm caches.
    if (changed && !syncRunning) runRebuild(STATUS.newBookmarksDetected);
  }
  return cachedBookmarks;
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getMime(path) {
  const ext = "." + path.split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

// Whitelist of extensions allowed for /media/ serving. ft only downloads
// photo/video formats from X's CDN; rejecting everything else defends against
// a crafted tweet producing an .svg/.html/.xml file that would execute scripts
// in our localhost origin if a user navigates directly to /media/foo.svg.
const MEDIA_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".mp4", ".webm", ".m4v", ".mov",
]);

// Stat a resolved path, returning Stats only for a regular file — directories
// and special files return null. `dist/assets` is a real directory, so a bare
// `GET /assets` resolves to it; createReadStream on a directory emits an async
// EISDIR that, absent an 'error' listener and a global trap, exits the process.
// Every file-serving branch funnels through this so a directory (or vanished)
// path 404s instead of taking the daemon down.
function statFile(file) {
  if (!file) return null;
  try {
    const st = statSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// Pipe a read stream to the response with a mid-stream 'error' guard. A file
// that disappears between stat and read (e.g. an `ft sync` rewriting media)
// emits 'error' on the source; unhandled, that crashes the daemon too. On
// error just tear the connection down — response headers may already be sent.
function pipeFile(stream, res) {
  stream.on("error", () => { if (!res.destroyed) res.destroy(); });
  stream.pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  setSecurityHeaders(res);
  if (!requireAllowedHost(req, res)) return;

  // API: bookmarks
  if (path === "/api/bookmarks") {
    getBookmarks()
      .then((bm) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(bm));
      })
      .catch((err) => {
        console.error("getBookmarks failed:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"failed to load bookmarks"}');
      });
    return;
  }

  // API: sync (shell out to ft commands)
  if (path === "/api/sync") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Allow": "POST", "Content-Type": "application/json" });
      res.end('{"error":"method not allowed"}');
      return;
    }
    if (!requireSameOrigin(req, res)) return;
    const url2 = new URL(req.url, `http://localhost:${PORT}`);
    const mode = url2.searchParams.get("mode") || "all";
    // Whitelist mode upfront — the downstream pipeline branches on `===`
    // comparisons (lines ~762, 779) so an unknown value silently does nothing
    // (sync starts, no phase runs, only rebuildCaches fires). Reject early so
    // the caller learns the input was wrong instead of getting a misleading
    // "ok" + a no-op sync.
    if (
      mode !== "all" &&
      mode !== "bookmarks-rebuild" &&
      mode !== "media" &&
      mode !== "gaps"
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"invalid mode"}');
      return;
    }
    if (syncRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"sync already running"}');
      return;
    }
    syncRunning = true;
    syncStep = STATUS.starting;
    syncError = null;
    cancelRequested = false;
    emitSync();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode }));
    // strip ANSI escape codes; preserve \r so callers can split on it (spinner frames)
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    // Idle-based timeout: kill only if no stdout/stderr activity for IDLE_MS.
    // Replaces the prior 120s hard timeout that killed legitimate long syncs
    // mid-fetch. ft's spinner emits frequently (every progress callback), so
    // 5 min of silence is a safe "actually hung" signal.
    const IDLE_MS = 5 * 60 * 1000;
    const run = (cmd, args, opts = {}) => new Promise((resolve) => {
      const { onOutput } = opts;
      // shell: true on Windows so npm-installed CLI shims (.cmd/.bat) resolve via PATH;
      // not needed (and avoided) on macOS/Linux where Node spawns binaries directly.
      const proc = spawnCmd(cmd, args, { shell: process.platform === "win32" });
      activeProc = proc;
      emitSync();
      // "ft sync", "ft sync --gaps", "ft fetch-media" — for failure lines.
      const label = [cmd, args[0], ...args.filter((a) => a === "--gaps" || a === "--rebuild")].join(" ");
      let spawnFailed = false;
      let idleKilled = false;
      let lastActivity = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_MS) {
          idleKilled = true;
          // kill() throws on some platforms if the proc is already exiting
          // (between idle-fire and 'close'); swallow so the interval can
          // clear cleanly either way.
          try { proc.kill(); } catch {}
          clearInterval(idleTimer);
        }
      }, 5000);
      const handleData = (d) => {
        lastActivity = Date.now();
        if (onOutput) onOutput(stripAnsi(d.toString()));
      };
      proc.stdout?.on("data", handleData);
      proc.stderr?.on("data", handleData);
      // 'error' fires when spawn itself fails (ENOENT for missing binary,
      // EACCES for non-executable) — distinct from a process that ran and
      // exited non-zero, which fires 'close'. Without this handler the event
      // is uncaught and crashes the server (no global uncaughtException
      // trap). With it registered, 'close' also fires afterward with the
      // libuv code; the handlers are idempotent so the double-fire is a
      // no-op past the first call.
      proc.on("error", (err) => {
        clearInterval(idleTimer);
        if (activeProc === proc) activeProc = null;
        spawnFailed = true;
        syncError = STATUS.spawnError(err.code);
        emitSync();
        resolve(false);
      });
      proc.on("close", (code, signal) => {
        clearInterval(idleTimer);
        if (activeProc === proc) activeProc = null;
        // A spawn failure already recorded its own line; a user cancel
        // (SIGINT, non-zero exit) is not a failure.
        if (!spawnFailed && code !== 0) {
          if (idleKilled) syncError = STATUS.idleKilled(label);
          else if (!cancelRequested) syncError = STATUS.exitError(label, code, signal);
        }
        emitSync();
        resolve(code === 0);
      });
    });
    (async () => {
      // Each ft phase is gated on !cancelRequested — runRebuild always runs so
      // any partial work that landed before cancel still gets thumbnailed /
      // color-extracted / dedup-hashed.
      //
      // Output parsing for bare `ft sync` (modes `all` and `bookmarks-rebuild`)
      // must handle three sub-phases the same process emits in sequence:
      //   1. Bookmarks spinner: "Syncing bookmarks...  N new │ page M │ Xs"
      //   2. Media spinner:     "Fetching media...  N processed │ M downloaded │ Xs"
      //   3. Indexing:           "Building search index..." (printed line)
      // Pre-ft-1.3.18 we ran ft sync (bookmarks only) then chained ft fetch-media;
      // since 1.3.18 ft sync auto-fetches media inline (with no --limit flag and
      // a hardcoded Infinity default in bookmark-media.ts), so we run bare ft
      // sync and parse all phases off one process. `--no-media` opts the user
      // out of the inline media phase entirely (Fetch Media stays available
      // for separate, capped runs).
      if (
        (mode === "all" || mode === "bookmarks-rebuild") &&
        !cancelRequested
      ) {
        syncStep = STATUS.syncingBookmarks;
        emitSync();
        const s = getSettings();
        // --yes skips ft's interactive "Continue? (y/N)" rebuild prompt
        // (cli.js:670). Our subprocess has no TTY so without --yes the readline
        // call hangs forever. The GUI's AlertDialog already obtained user
        // consent before this request landed.
        const syncArgs = mode === "bookmarks-rebuild"
          ? ["sync", "--rebuild", "--yes"]
          : ["sync"];
        if (s.skipMedia) syncArgs.push("--no-media");
        if (s.skipProfileImages) syncArgs.push("--skip-profile-images");
        await run("ft", syncArgs, {
          onOutput: (chunk) => {
            // Process all lines in the chunk so we don't miss the printed
            // "Building search index..." transition when it shares a chunk
            // with the trailing media-spinner frame.
            const lines = chunk.split(/[\r\n]/).map(s => s.trim()).filter(Boolean);
            for (const line of lines) {
              const newMatch = line.match(/(\d+)\s+new/);
              if (newMatch) {
                const count = parseInt(newMatch[1], 10);
                if (Number.isFinite(count) && count >= 0 && count < 1_000_000) {
                  syncStep = STATUS.newBookmarks(count);
                  emitSync();
                }
                continue;
              }
              const mediaMatch = line.match(/Fetching media.*?(\d+)\s+processed.*?(\d+)\s+downloaded/);
              if (mediaMatch) {
                const processed = parseInt(mediaMatch[1], 10);
                const downloaded = parseInt(mediaMatch[2], 10);
                if (Number.isFinite(processed) && Number.isFinite(downloaded) && processed >= 0 && processed < 10_000_000) {
                  const next = STATUS.mediaProgress(processed, downloaded);
                  if (next !== null) {
                    syncStep = next;
                    emitSync();
                  }
                }
                continue;
              }
              if (line.includes("Building search index")) {
                syncStep = STATUS.indexing;
                emitSync();
                continue;
              }
            }
          }
        });
      }
      if (mode === "media" && !cancelRequested) {
        syncStep = STATUS.fetchingMedia;
        emitSync();
        const s = getSettings();
        // No --limit when mediaFetchLimit is 0 — ft fetch-media falls through
        // to Infinity (its post-1.3.13 default). With --limit, ft caps the
        // batch at that many bookmarks.
        const args = ["fetch-media"];
        if (s.mediaFetchLimit > 0) args.push("--limit", String(s.mediaFetchLimit));
        if (s.skipProfileImages) args.push("--skip-profile-images");
        // Parse ft's spinner line (cli.ts:142 prints
        //   "Fetching media...  N processed  │  M downloaded  │  Ts")
        // and surface processed (total attempts). No X/Y — ft doesn't expose
        // the total in its output. Step string deliberately omits X/Y so the
        // sidebar Progress switches to the barber animation (indeterminate
        // path in progress.tsx, triggered when `value == null`).
        await run("ft", args, {
          onOutput: (chunk) => {
            const lastFrame = chunk.split(/[\r\n]/).map(s => s.trim()).filter(Boolean).pop();
            const m = lastFrame?.match(/(\d+)\s+processed.*?(\d+)\s+downloaded/);
            if (!m) return;
            const processed = parseInt(m[1], 10);
            const downloaded = parseInt(m[2], 10);
            if (!Number.isFinite(processed) || !Number.isFinite(downloaded)) return;
            if (processed < 0 || processed >= 10_000_000) return;
            const next = STATUS.mediaProgress(processed, downloaded);
            if (next !== null) {
              syncStep = next;
              emitSync();
            }
          },
        });
      }
      if (mode === "gaps" && !cancelRequested) {
        syncStep = STATUS.fillingGaps;
        emitSync();
        // ft's --gaps spinner emits frames like
        //   "\r\x1b[K  ⠋ <done>/<total> (<pct>%) │ <N> quoted │ ... │ <Ns>"
        // separated by \r at 80ms intervals. After stripAnsi removes the
        // \x1b[K, the line starts with two spaces + a spinner glyph (one
        // of ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ from createSpinner in ft's cli.js:32) before the
        // X/Y headline — so we can NOT anchor the regex to start of line.
        // Match (\d+)/(\d+) anywhere in the frame; safe because ft's gaps
        // output has no other slash-separated digit pair. Then split on │
        // to pick up the labelled breakdown segments. No --yes needed —
        // verified from ft source that --gaps has no interactive prompt.
        await run("ft", ["sync", "--gaps"], {
          onOutput: (chunk) => {
            const lastFrame = chunk.split(/[\r\n]/).map(s => s.trim()).filter(Boolean).pop();
            if (!lastFrame) return;
            const m = lastFrame.match(/(\d+)\/(\d+)/);
            if (!m) return;
            const done = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
            const breakdown = { quoted: 0, expanded: 0, articles: 0, failed: 0 };
            for (const seg of lastFrame.split("│").slice(1).map(s => s.trim())) {
              const sm = seg.match(/^(\d+)\s+(quoted|expanded|articles|failed)\b/);
              if (sm) breakdown[sm[2]] = parseInt(sm[1], 10);
            }
            syncStep = STATUS.gapsProgress(done, total, breakdown);
            emitSync();
          },
        });
      }
      await runRebuild(STATUS.buildingCaches);
    })().catch((e) => {
      // Belt-and-braces: the pipeline above could throw before reaching
      // runRebuild. spawnCmd can throw synchronously on bad input (which
      // rejects run()'s promise via the Promise-executor catch). getSettings
      // can throw on a mid-sync settings.json corruption. emitSync writing to
      // a dead SSE client is also a candidate. Without this, syncRunning
      // would stick at true forever and the Sync button would silently
      // refuse to work until server restart — the kind of bug that's
      // invisible until production and miserable to debug.
      console.error("sync pipeline failed:", e);
      syncError = STATUS.pipelineError;
    }).finally(() => {
      // Ownership: runRebuild owns syncRunning while it's in flight (its own
      // .finally at line ~617 clears it on completion). Only reset here when
      // the IIFE exited before handing off — otherwise we'd race with
      // runRebuild's cleanup and risk clearing while the rebuild is still
      // building. activeRebuild === null means runRebuild already finished
      // OR never started.
      if (!activeRebuild) {
        syncRunning = false;
        syncStep = null;
        emitSync();
      }
    });
    return;
  }

  // API: cancel the active ft subprocess. SIGINT on Unix because that's the
  // only signal ft listens for — SIGTERM/SIGHUP just kill the process with no
  // handler. ft's SIGINT handler does not currently flush in-flight state
  // (sync cursor, media manifest); tracked at fieldtheory-cli#142. Windows
  // falls back to SIGTERM since signal semantics differ. 409 if no proc to
  // cancel (UI disables the button when `canCancel` is false, but defense in
  // depth).
  if (path === "/api/sync/cancel") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end('{"error":"method not allowed"}');
      return;
    }
    if (!requireSameOrigin(req, res)) return;
    if (!activeProc) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"nothing to cancel"}');
      return;
    }
    cancelRequested = true;
    // TOCTOU race: 'close' could fire between the `!activeProc` check
    // above and this line, nulling activeProc. kill() can also throw if
    // the proc is mid-exit. Swallow either way — the cancel intent is
    // recorded via cancelRequested, the natural close path will run.
    try {
      activeProc.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT");
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // API: sync status (legacy polling endpoint — kept for backward compat)
  if (path === "/api/sync-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(syncSnapshot()));
    return;
  }

  // API: SSE stream for real-time sync progress
  if (path === "/api/sync-stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // res.write to a closed socket throws — detach the listener on failure
    // so subsequent emitSync calls don't keep retrying and crashing. The
    // request handler has no surrounding try/catch and no global uncaught-
    // Exception trap, so an uncaught throw here takes down the daemon.
    const send = (data) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        syncEvents.off("update", send);
      }
    };
    send(syncSnapshot());
    syncEvents.on("update", send);
    // Symmetric cleanup: 'close' covers normal disconnect, 'error' covers
    // connection failure modes (TCP reset, header parse error mid-flight)
    // where the listener would otherwise leak and keep writing to a dead
    // socket on every emitSync.
    const detach = () => syncEvents.off("update", send);
    req.on("close", detach);
    req.on("error", detach);
    return;
  }

  // API: app info (name/version/license/author) — for the About card.
  // Read from `pkg` at startup, so updating package.json and rebuilding is
  // enough; no restart needed for the SSR-less client to pick it up.
  // `ft` is detected on every call (no cache) so an upgrade is reflected
  // without restarting the GUI server.
  if (path === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const detected = detectFtVersion();
    const ft = detected
      ? { version: detected.version, status: ftStatus(detected.version), testedMin: FT_TESTED.min, testedMax: FT_TESTED.max }
      : null;
    // `hasData` lets FtGate distinguish "first-time user with nothing" (full
    // FtNotInstalled screen) from "existing user without ft on path" (browse-
    // only mode with sync controls disabled). Cheap existence check on the
    // jsonl ft writes — no need to load or count.
    const hasData = existsSync(join(FT, "bookmarks.jsonl"));
    res.end(JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      author: pkg.author,
      ft,
      hasData,
      // Media directory, home-relative, so client-side exports (Markdown) can
      // emit local file paths an agent with shell access can open directly.
      mediaDir: tildify(join(FT, "media")),
    }));
    return;
  }

  // API: settings (read-all / partial-update)
  if (path === "/api/settings") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getSettings()));
      return;
    }
    if (req.method === "POST") {
      if (!requireSameOrigin(req, res)) return;
      const MAX_BODY = 64 * 1024;
      let body = "";
      let aborted = false;
      req.on("data", (c) => {
        if (aborted) return;
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"payload too large"}');
          req.destroy();
        }
      });
      req.on("end", () => {
        // Wrap the whole body so a synchronous throw from saveSettings
        // (atomicWriteFileSync → writeFileSync can fail on ENOSPC, EACCES,
        // EIO, etc.) doesn't escape the listener and crash the server. The
        // headersSent guard avoids a second writeHead if the throw happened
        // after we already responded.
        try {
          if (aborted) return;
          let parsed;
          try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid json"}');
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"expected object"}');
            return;
          }
          const next = saveSettings(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(next));
        } catch (e) {
          console.error("POST /api/settings failed:", e);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"internal server error"}');
          }
        }
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end('{"error":"method not allowed"}');
    return;
  }

  // API: archive (persists archived-bookmark IDs; in-memory state is `hiddenIds`)
  if (path === "/api/archive") {
    const archivedPath = join(CACHE_DIR, "archived.json");
    if (req.method === "GET") {
      // Defensive parse: atomic-write prevents OUR mid-write truncation, but
      // environmental causes (manual edits, cloud-sync interrupts, bad sectors)
      // can still leave a malformed file. A synchronous throw here escapes the
      // request handler and crashes the server (no global uncaughtException
      // trap), so swallow + return empty.
      let ids = [];
      if (existsSync(archivedPath)) {
        try { ids = JSON.parse(readFileSync(archivedPath, "utf-8")); }
        catch (e) { console.error("archived.json unreadable, returning empty:", e.message); }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ids));
      return;
    }
    if (req.method === "POST") {
      if (!requireSameOrigin(req, res)) return;
      const MAX_BODY = 2 * 1024 * 1024; // 2 MB is plenty — even 100k bookmark IDs fit
      let body = "";
      let aborted = false;
      req.on("data", c => {
        if (aborted) return;
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"payload too large"}');
          req.destroy();
        }
      });
      req.on("end", () => {
        // Wrap the whole body so synchronous throws (mkdirSync / atomic-
        // WriteFileSync on disk failure, or unexpected JSON-stringify edge
        // cases) don't escape the listener and crash the server. Headers-
        // Sent guard avoids a second writeHead if the throw happened after
        // we already responded.
        try {
          if (aborted) return;
          let parsed;
          try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid json"}');
            return;
          }
          // Per-element length cap defends against a single 2MB string
          // passing the 2MB body cap and landing in archived.json as a
          // bloated fake ID. Twitter snowflake IDs are 19 digits — 64 is
          // a generous ceiling that catches obvious abuse without
          // documenting a hard limit.
          if (
            !Array.isArray(parsed) ||
            !parsed.every((x) => typeof x === "string" && x.length < 64)
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"expected string[]"}');
            return;
          }
          if (!existsSync(join(CACHE_DIR))) mkdirSync(join(CACHE_DIR), { recursive: true });
          atomicWriteFileSync(archivedPath, JSON.stringify(parsed));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          console.error("POST /api/archive failed:", e);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"internal server error"}');
          }
        }
      });
      return;
    }
    res.writeHead(405, { "Allow": "GET, POST", "Content-Type": "application/json" });
    res.end('{"error":"method not allowed"}');
    return;
  }

  // API: collections (user-named, non-exclusive groupings of bookmark IDs).
  // Same storage contract as /api/archive: the client owns the full document
  // and POSTs it whole; the server validates shape and atomically replaces
  // collections.json. Membership is a set — order is not meaningful.
  // `hidden` excludes the collection's members from Home/Gallery (per-
  // collection archive); the collection tab itself always shows them.
  if (path === "/api/collections") {
    const collectionsPath = join(CACHE_DIR, "collections.json");
    if (req.method === "GET") {
      let list = [];
      if (existsSync(collectionsPath)) {
        try { list = JSON.parse(readFileSync(collectionsPath, "utf-8")); }
        catch (e) { console.error("collections.json unreadable, returning empty:", e.message); }
      }
      if (!Array.isArray(list)) list = [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === "POST") {
      if (!requireSameOrigin(req, res)) return;
      const MAX_BODY = 4 * 1024 * 1024;
      let body = "";
      let aborted = false;
      req.on("data", c => {
        if (aborted) return;
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"payload too large"}');
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          if (aborted) return;
          let parsed;
          try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid json"}');
            return;
          }
          const isId = (x) => typeof x === "string" && x.length > 0 && x.length < 64;
          const valid =
            Array.isArray(parsed) &&
            parsed.every(
              (c) =>
                c && typeof c === "object" && !Array.isArray(c) &&
                isId(c.id) &&
                typeof c.name === "string" && c.name.length > 0 && c.name.length <= 200 &&
                typeof c.createdAt === "string" && c.createdAt.length < 64 &&
                (c.hidden === undefined || typeof c.hidden === "boolean") &&
                Array.isArray(c.ids) && c.ids.every(isId),
            ) &&
            new Set(parsed.map((c) => c.id)).size === parsed.length;
          if (!valid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"expected {id,name,createdAt,ids}[]"}');
            return;
          }
          // Re-serialize from the validated fields only, so unknown keys
          // never land on disk.
          const clean = parsed.map((c) => ({
            id: c.id,
            name: c.name,
            createdAt: c.createdAt,
            hidden: c.hidden === true,
            ids: [...new Set(c.ids)],
          }));
          if (!existsSync(join(CACHE_DIR))) mkdirSync(join(CACHE_DIR), { recursive: true });
          atomicWriteFileSync(collectionsPath, JSON.stringify(clean));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          console.error("POST /api/collections failed:", e);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"internal server error"}');
          }
        }
      });
      return;
    }
    res.writeHead(405, { "Allow": "GET, POST", "Content-Type": "application/json" });
    res.end('{"error":"method not allowed"}');
    return;
  }

  // API: duplicates
  if (path === "/api/duplicates") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dedupResult));
    return;
  }

  // Serve thumbnails
  if (path.startsWith("/thumbs/")) {
    const base = join(CACHE_DIR, "thumbnails");
    const file = safeJoin(base, path.slice(8));
    if (statFile(file)) {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      pipeFile(createReadStream(file), res);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // Serve local media files (with range request support for Safari video)
  if (path.startsWith("/media/")) {
    const base = join(FT, "media");
    const file = safeJoin(base, path.slice(7));
    const st = statFile(file);
    if (!st) { res.writeHead(404); res.end("Not found"); return; }

    // Reject anything outside the known ft media formats. See MEDIA_EXTS.
    const ext = "." + file.split(".").pop().toLowerCase();
    if (!MEDIA_EXTS.has(ext)) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end('{"error":"unsupported media type"}');
      return;
    }

    const mime = getMime(file);
    const size = st.size;
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace("bytes=", "").split("-");
      let start = parseInt(startStr, 10);
      let end = endStr ? parseInt(endStr, 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      pipeFile(createReadStream(file, { start, end }), res);
    } else {
      res.writeHead(200, {
        "Content-Length": size,
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
      });
      pipeFile(createReadStream(file), res);
    }
    return;
  }

  // Serve the built Vite client from dist/ (constrained to distDir)
  const distDir = join(__dirname, "dist");
  const filePath = path === "/" ? join(distDir, "index.html") : safeJoin(distDir, path.slice(1));
  if (statFile(filePath)) {
    res.writeHead(200, { "Content-Type": getMime(filePath) });
    pipeFile(createReadStream(filePath), res);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// Start initial rebuild BEFORE listen() completes, so requests racing with startup
// share the same in-flight rebuild via runRebuild().
runRebuild(STATUS.buildingCaches);
// `autoOpenBrowser` in settings is the primary knob. argv/CI/BROWSER env
// overrides still apply so automation and `--no-open` invocations don't pop a
// window even if the setting is on. Read once at startup — changes require a
// restart.
const shouldOpen =
  getSettings().autoOpenBrowser &&
  !process.argv.includes("--no-open") &&
  !process.env.CI &&
  process.env.BROWSER !== "none";

// Try PORT, then PORT+1, PORT+2, ... on EADDRINUSE. If PORT was pinned via env,
// skip the fallback — the user asked for that exact port and should see it fail
// rather than silently land somewhere else.
//
// Explicit listeners (not the listen(cb) form) so we can remove the pending
// 'listening' handler on error — otherwise it persists on the server instance
// and fires when a later port succeeds, printing the boot line twice.
function listenWithFallback(port, attempts = 10) {
  const onSuccess = () => {
    server.removeListener("error", onError);
    PORT = port;
    const url = `http://localhost:${port}`;
    console.log(`→ ${pkg.name} ${url}`);
    // Surface the ft trust model: server.js spawns bare "ft", so it's
    // whatever's first on the user's PATH. Logging the version makes the
    // resolution visible — and warns loudly when ft is missing instead of
    // letting sync fail silently on first click.
    const ftInfo = detectFtVersion();
    if (ftInfo) console.log(`  fieldtheory ${ftInfo.version} on PATH`);
    else console.log(`  WARNING: fieldtheory CLI not found on PATH — sync features will fail until \`npm i -g fieldtheory\``);
    if (shouldOpen) open(url).catch(() => {});
  };
  const onError = (err) => {
    server.removeListener("listening", onSuccess);
    if (err.code === "EADDRINUSE" && attempts > 0 && !PORT_PINNED) {
      listenWithFallback(port + 1, attempts - 1);
    } else {
      console.error(`Could not bind to port ${port}: ${err.message}`);
      process.exit(1);
    }
  };
  server.once("listening", onSuccess);
  server.once("error", onError);
  server.listen(port, "127.0.0.1");
}

listenWithFallback(PORT);
