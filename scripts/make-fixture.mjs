#!/usr/bin/env node
// Writes a synthetic fieldtheory-cli archive, so index-n2 can be run, looked
// at and screenshotted without anyone's real bookmarks. Every handle, name,
// text, link and image here is invented.
//
// Output, under node_modules/.cache/ (ignored by git and npm):
//   ft-data/      what ft leaves in ~/.ft-bookmarks: bookmarks.jsonl,
//                 bookmarks.db, media-manifest.json, media/
//   cache/        seeded archived.json and collections.json; the server
//                 builds colors, thumbnails and dedup itself on start
//   fixture.json  generation metadata and the case name -> bookmark id map
//                 that check-fixture.mjs verifies against /api/bookmarks.
//                 Written last, so its presence means the fixture is whole.
//
// Usage: node scripts/make-fixture.mjs [--corrupt] [--now <iso date>]
//   --corrupt  a separate variant: one malformed jsonl line, a `{}` media
//              manifest and a non-array archived.json
//   --now      pins "now" for the today / yesterday cases and timestamps
//
// A seeded RNG drives every choice, so output depends only on --now (and on
// whether ffmpeg is on PATH, which decides if playable mp4s are written).
//
// Record shapes follow ft's own code: convertTweetToRecord for jsonl rows,
// fetchBookmarkMediaBatch for manifest entries and media file names
// (<tweetId>-<sha256:16>.<ext>, profile images <sha256:16>.<ext>), and the
// bookmarks table in bookmarks-db.

import sharp from "sharp";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fixtureRoot } from "./fixture-config.mjs";

const argv = process.argv.slice(2);
const CORRUPT = argv.includes("--corrupt");
const nowAt = argv.indexOf("--now");
const NOW = nowAt >= 0 ? new Date(argv[nowAt + 1]) : new Date();
if (Number.isNaN(NOW.getTime())) {
  console.error("make-fixture: --now needs a date, e.g. --now 2026-11-11T12:00:00Z");
  process.exit(2);
}

const SEED = 20261111;
const FILLER_COUNT = 1500;
const MAX_BYTES = 200 * 1024 * 1024;

const ROOT = fixtureRoot(CORRUPT);
const FT_DIR = join(ROOT, "ft-data");
const MEDIA_DIR = join(FT_DIR, "media");
const CACHE_DIR = join(ROOT, "cache");

// The wipe below is recursive; refuse anything but the fixture directory.
if (!ROOT.includes(`${sep}node_modules${sep}.cache${sep}index-n2-fixture`)) {
  throw new Error(`refusing to write outside the fixture directory: ${ROOT}`);
}
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

// --- Seeded randomness ------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const code = (n) => Array.from({ length: n }, () => pick(ALNUM)).join("");

// --- Dates ------------------------------------------------------------------

const DAY_MS = 86_400_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");

// X's legacy created_at, which ft stores as postedAt unchanged:
// "Sun May 03 12:19:31 +0000 2026".
function legacyDate(d) {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}
const iso = (ms) => new Date(ms).toISOString();
const SYNCED_AT = iso(NOW.getTime() - 30 * 60_000);
const randomDate = (fromIso, toMs) => {
  const from = Date.parse(fromIso);
  return new Date(from + Math.floor(rand() * (toMs - from)));
};

// --- Text -------------------------------------------------------------------

const NOUNS = ["fixture", "lattice", "widget", "harbor", "ledger", "orbit", "prism", "beacon", "parcel",
  "kernel", "canvas", "relay", "quartz", "meadow", "signal", "vector", "cobalt", "tundra", "copper",
  "glyph", "module", "sprite", "buffer", "schema", "lantern", "anchor", "pigment", "gasket"];
const ADJS = ["quiet", "synthetic", "sample", "modular", "sparse", "dense", "amber", "linear", "nested",
  "hollow", "bright", "plain", "rapid", "steady", "minor", "major", "tidy", "coarse", "narrow"];
const VERBS = ["renders", "indexes", "wraps", "splits", "sorts", "filters", "caches", "rotates",
  "folds", "maps", "measures", "scans", "trims", "tags", "groups"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function sentence() {
  const tail = chance(0.35) ? ` before the ${pick(ADJS)} ${pick(NOUNS)}` : "";
  return `${cap(pick(ADJS))} ${pick(NOUNS)} ${pick(VERBS)} the ${pick(ADJS)} ${pick(NOUNS)}${tail}.`;
}
function paragraph(min, max) {
  return Array.from({ length: int(min, max) }, sentence).join(" ");
}

// Pads `prefix` with plain BMP words to exactly `len` UTF-16 units, ending
// in a space, so the next token starts at index `len`.
const BY_LEN = ["", "a", "an", "the", "each", "small", "sample", "fixture", "checking", "rendering", "truncation"];
function fillTo(prefix, len) {
  let s = prefix;
  while (len - s.length > 22) s += pick(BY_LEN.slice(2)) + " ";
  const r = len - s.length - 2;
  if (r < 10 || r > 20) throw new Error(`fillTo: prefix too long for ${len}`);
  const a = Math.floor(r / 2);
  s += `${BY_LEN[a]} ${BY_LEN[r - a]} `;
  if (s.length !== len) throw new Error("fillTo: length mismatch");
  return s;
}

// Same normalization the server's text dedup applies, so fillers never form
// an accidental duplicate group; only the designed pair shares a text.
const usedTexts = new Set();
const normText = (t) => t.toLowerCase().replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, "")
  .replace(/@\w+/g, "").replace(/\s+/g, " ").trim();
function claimText(t) {
  const n = normText(t);
  if (n.length >= 20 && usedTexts.has(n)) return false;
  usedTexts.add(n);
  return true;
}

// --- Images -----------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// A smooth field of randomly lit cells around one hue: distinct per seed
// (so perceptual hashes differ), never a flat fill (so the dedup pass keeps
// it and the color pass has a palette to report).
async function blobImage({ w, h, hue = 0, sat = 0.6, light = 0.5, spread = 0.18, seed, cols, rows,
  shift = 0, format = "jpeg", quality = 84 }) {
  const r = mulberry32(seed);
  const long = Math.max(w, h);
  cols ??= Math.max(3, Math.round((7 * w) / long));
  rows ??= Math.max(3, Math.round((7 * h) / long));
  const px = Buffer.alloc(cols * rows * 3);
  for (let i = 0; i < cols * rows; i++) {
    const l = clamp(light + (r() * 2 - 1) * spread, 0.04, 0.96);
    const hh = (((hue + (r() * 2 - 1) * 10) % 360) + 360) % 360;
    const rgb = hslToRgb(hh, sat, l);
    for (let c = 0; c < 3; c++) px[i * 3 + c] = clamp(Math.round(rgb[c] + shift), 0, 255);
  }
  const img = sharp(px, { raw: { width: cols, height: rows, channels: 3 } })
    .resize(w, h, { kernel: "cubic", fit: "fill" });
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality }).toBuffer();
}

// --- Video ------------------------------------------------------------------

// Short real mp4s when ffmpeg is on PATH: one for videos, one for GIFs (X
// serves animated GIFs as mp4). Without ffmpeg those items keep only their
// poster on disk and render as stills.
function makeMp4(name, source) {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return null;
  const tmp = join(ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, `${name}.mp4`);
  const encoders = [
    ["-c:v", "libx264", "-preset", "veryfast", "-threads", "1"],
    ["-c:v", "h264_videotoolbox"],
  ];
  try {
    for (const enc of encoders) {
      const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source,
        "-t", "3", ...enc, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out], { stdio: "ignore" });
      if (res.status === 0 && existsSync(out)) return readFileSync(out);
    }
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const MP4 = {
  video: makeMp4("video", "testsrc2=size=640x360:rate=24"),
  gif: makeMp4("gif", "life=size=320x240:rate=15:ratio=0.35:seed=7:life_color=#fde047:death_color=#1e3a8a"),
};

// --- Media manifest ---------------------------------------------------------

// Keyed like ft's manifest: profile images by URL, everything else by
// (tweetId, sourceUrl). One file per key.
const entries = new Map();
const entryKey = (e) => (e.sourceUrl.includes("/profile_images/") ? `profile::${e.sourceUrl}` : `${e.tweetId}::${e.sourceUrl}`);
const fetchedAt = () => iso(NOW.getTime() - int(2, 120) * 60_000);
function addEntry(e) {
  const key = entryKey(e);
  if (!entries.has(key)) entries.set(key, e);
}
function ctxFields(ctx) {
  return {
    bookmarkId: ctx.bookmarkId, tweetId: ctx.tweetId, tweetUrl: ctx.tweetUrl,
    authorHandle: ctx.authorHandle, authorName: ctx.authorName,
  };
}
function saveFile(ctx, sourceUrl, buffer, ext, contentType, isProfileImage = false) {
  const base = ctxFields(ctx);
  if (entries.has(entryKey({ ...base, sourceUrl }))) return;
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const filename = isProfileImage ? `${digest}${ext}` : `${ctx.tweetId}-${digest}${ext}`;
  const localPath = join(MEDIA_DIR, filename);
  writeFileSync(localPath, buffer);
  addEntry({ ...base, sourceUrl, localPath, contentType, bytes: buffer.length, status: "downloaded", fetchedAt: fetchedAt() });
}

// --- Accounts ---------------------------------------------------------------

const accounts = new Map();
// pfp: "downloaded" (file on disk), "missing" (URL known, never fetched),
// "none" (no profile image URL at all).
function account(handle, name, pfp = "downloaded") {
  const k = accounts.size + 1;
  const a = {
    k, handle, name, pfp,
    userId: (1980000000000000000n + BigInt(k)).toString(),
    pfpUrl: pfp === "none" ? undefined
      : `https://pbs.twimg.com/profile_images/${1970000000000000000n + BigInt(k)}/${code(8)}_normal.jpg`,
    hue: (k * 47) % 360,
    followers: int(0, 250_000),
    following: int(0, 3_000),
  };
  accounts.set(handle, a);
  return a;
}
async function ensurePfp(acct, ctx) {
  if (acct.pfp !== "downloaded") return;
  const url = acct.pfpUrl.replace("_normal.", "_400x400.");
  if (entries.has(`profile::${url}`)) return;
  const buf = await blobImage({ w: 400, h: 400, hue: acct.hue, sat: 0.55, light: 0.55, cols: 3, rows: 3, seed: 9000 + acct.k });
  saveFile(ctx, url, buf, ".jpg", "image/jpeg", true);
}

const A = {
  alice: account("fixture_alice", "Fixture Alice"),
  bob: account("fixture_bob", "Fixture Bob"),
  carol: account("fixture_carol", "Fixture Carol"),
  dave: account("fixture_dave", "Fixture Dave"),
  erin: account("fixture_erin", "Fixture Erin"),
  frank: account("fixture_frank", "Fixture Frank"),
  grace: account("fixture_grace", "Fixture Grace"),
  heidi: account("fixture_heidi", "Fixture Heidi"),
  nopfp: account("fixture_nopfp", "Fixture No Avatar File", "missing"),
  nourl: account("fixture_nourl", "Fixture No Avatar URL", "none"),
};
const MAIN = [A.alice, A.bob, A.carol, A.dave, A.erin, A.frank, A.grace, A.heidi];
const FILLER_ACCTS = Array.from({ length: 40 }, (_, i) =>
  account(`fixture_acct_${p2(i)}`, `Fixture Account ${p2(i)}`, i === 7 ? "none" : i % 13 === 5 ? "missing" : "downloaded"));

// --- Records ----------------------------------------------------------------

const tweetId = (n) => (1990000000000000000n + BigInt(n)).toString();
let edgeN = 0;
let auxN = 500; // tweets that are referenced (quoted, replied to) but not bookmarked
const nextEdgeId = () => tweetId(++edgeN);
const nextAuxId = () => tweetId(++auxN);

const records = [];
const dbRows = new Map(); // id -> { primary, categories, article* }
const cases = {};
const tag = (id, ...names) => { for (const n of names) (cases[n] ??= []).push(id); };

const SOURCE_APP = '<a href="https://example.com/fixture-client" rel="nofollow">Fixture Client</a>';
const CATEGORY_SLUGS = ["tool", "security", "technique", "launch", "research", "opinion", "commerce"];

function ctxFor(id, acct) {
  return { bookmarkId: id, tweetId: id, tweetUrl: `https://x.com/${acct.handle}/status/${id}`, authorHandle: acct.handle, authorName: acct.name };
}
function randomEngagement() {
  const e = (max) => Math.floor(Math.exp(rand() * Math.log(max + 1))) - 1;
  return { likeCount: e(80_000), repostCount: e(12_000), replyCount: e(3_000), quoteCount: e(1_500), bookmarkCount: e(20_000) };
}
function randomCategories(id) {
  if (chance(0.3)) { dbRows.set(id, { primary: "unclassified", categories: null }); return; }
  const n = chance(0.6) ? 1 : chance(0.7) ? 2 : 3;
  const cats = [...new Set(Array.from({ length: n }, () => pick(CATEGORY_SLUGS)))];
  dbRows.set(id, { primary: cats[0], categories: cats.join(",") });
}

function record(id, acct, f) {
  const engagement = f.engagement ?? randomEngagement();
  const mediaObjects = f.mediaObjects ?? [];
  const r = {
    id,
    tweetId: id,
    url: `https://x.com/${acct.handle}/status/${id}`,
    text: f.text,
    authorHandle: acct.handle,
    authorName: acct.name,
    authorProfileImageUrl: acct.pfpUrl,
    author: {
      id: acct.userId, handle: acct.handle, name: acct.name, profileImageUrl: acct.pfpUrl,
      bio: "Invented account for index-n2 test data.", followerCount: acct.followers,
      followingCount: acct.following, isVerified: false, snapshotAt: SYNCED_AT,
    },
    postedAt: legacyDate(f.posted),
    bookmarkedAt: null,
    syncedAt: SYNCED_AT,
    conversationId: f.conversationId ?? id,
    inReplyToStatusId: f.inReplyToStatusId,
    inReplyToUserId: f.inReplyToUserId,
    quotedStatusId: f.quotedStatusId ?? f.quotedTweet?.id,
    quotedTweet: f.quotedTweet,
    language: f.language ?? "en",
    sourceApp: SOURCE_APP,
    possiblySensitive: false,
    engagement: { ...engagement, viewCount: undefined },
    media: mediaObjects.map((m) => m.url),
    mediaObjects,
    links: f.links ?? [],
    tags: [],
    ingestedVia: "graphql",
    sortIndex: (1999999999999999999n - BigInt(records.length)).toString(),
  };
  records.push(r);
  if (!dbRows.has(id)) randomCategories(id);
  return r;
}

// Media object as ft builds it from extended_entities. ft downloads
// media_url_https, which X caps near 1200 px, so files are smaller than the
// original_info dimensions recorded in width/height.
async function photo(ctx, { w = 1600, h = 1200, file = true, dims = true, img = {}, format = "jpeg", fileLong = 900 } = {}) {
  const ext = format === "png" ? ".png" : ".jpg";
  const url = `https://pbs.twimg.com/media/${code(15)}${ext}`;
  ctx.mediaIdx = (ctx.mediaIdx ?? 0) + 1;
  const mo = {
    type: "photo", url, expandedUrl: `${ctx.tweetUrl}/photo/${ctx.mediaIdx}`,
    width: dims ? w : undefined, height: dims ? h : undefined,
  };
  if (file) {
    const scale = Math.min(1, fileLong / Math.max(w, h));
    const buf = await blobImage({
      w: Math.round(w * scale), h: Math.round(h * scale), seed: int(1, 2 ** 31 - 1),
      hue: rand() * 360, sat: 0.35 + rand() * 0.45, light: 0.35 + rand() * 0.3, format, ...img,
    });
    saveFile(ctx, url, buf, ext, format === "png" ? "image/png" : "image/jpeg");
  }
  return mo;
}

// `mp4`: what happened to the top-bitrate variant — "downloaded",
// "skipped_too_large", "failed", or "none" (never attempted).
async function videoItem(ctx, { kind = "video", w = 1280, h = 720, variants = true, mp4 = "downloaded", poster = true }) {
  const c = code(12);
  const mid = (1960000000000000000n + BigInt(int(1, 999_999_999))).toString();
  const posterUrl = kind === "video"
    ? `https://pbs.twimg.com/amplify_video_thumb/${mid}/img/${c}.jpg`
    : `https://pbs.twimg.com/tweet_video_thumb/${c}.jpg`;
  const videoVariants = !variants ? undefined : kind === "video"
    ? [
      { bitrate: 2176000, url: `https://video.twimg.com/amplify_video/${mid}/vid/avc1/1280x720/${c}.mp4?tag=16` },
      { bitrate: 832000, url: `https://video.twimg.com/amplify_video/${mid}/vid/avc1/640x360/${c}.mp4?tag=16` },
      { bitrate: 256000, url: `https://video.twimg.com/amplify_video/${mid}/vid/avc1/480x270/${c}.mp4?tag=16` },
    ]
    : [{ bitrate: 0, url: `https://video.twimg.com/tweet_video/${c}.mp4` }];
  const mo = { type: kind, url: posterUrl, expandedUrl: `${ctx.tweetUrl}/video/1`, width: w, height: h, videoVariants };
  if (poster) {
    const scale = Math.min(1, 900 / Math.max(w, h));
    // Horizontal bands, so a poster reads differently from a photo.
    const buf = await blobImage({ w: Math.round(w * scale), h: Math.round(h * scale), cols: 1, rows: 6,
      hue: rand() * 360, sat: 0.5, light: 0.45, spread: 0.3, seed: int(1, 2 ** 31 - 1) });
    saveFile(ctx, posterUrl, buf, ".jpg", "image/jpeg");
  }
  const top = videoVariants?.[0];
  if (top && mp4 === "downloaded") {
    const bytes = kind === "video" ? MP4.video : MP4.gif;
    if (bytes) saveFile(ctx, top.url, bytes, ".mp4", "video/mp4");
  } else if (top && mp4 === "skipped_too_large") {
    const bytes = 250 * 1024 * 1024;
    addEntry({ ...ctxFields(ctx), sourceUrl: top.url, contentType: "video/mp4", bytes, status: "skipped_too_large",
      reason: `content-length ${bytes} exceeds max ${MAX_BYTES}`, fetchedAt: fetchedAt() });
  } else if (top && mp4 === "failed") {
    addEntry({ ...ctxFields(ctx), sourceUrl: top.url, status: "failed", reason: "HTTP 403", fetchedAt: fetchedAt() });
  }
  return mo;
}

// quotedTweet as ft stores it. Its media is fetched under the quoted
// tweet's id, attributed to the bookmark that quotes it.
async function quoted(outerId, acct, { id = nextAuxId(), text, posted, media = async () => [] }) {
  const url = `https://x.com/${acct.handle}/status/${id}`;
  const ctx = { bookmarkId: outerId, tweetId: id, tweetUrl: url, authorHandle: acct.handle, authorName: acct.name };
  const mediaObjects = await media(ctx);
  await ensurePfp(acct, ctx);
  return {
    id, text, authorHandle: acct.handle, authorName: acct.name, authorProfileImageUrl: acct.pfpUrl,
    postedAt: legacyDate(posted), media: mediaObjects.map((m) => m.url), mediaObjects, url,
  };
}

// One edge-case bookmark. `build(ctx, id)` returns the record fields
// (media awaited inside); `tags` name the cases it covers.
async function edge(tags, acct, build) {
  const id = nextEdgeId();
  const ctx = ctxFor(id, acct);
  await ensurePfp(acct, ctx);
  const f = await build(ctx, id);
  f.posted ??= randomDate("2023-01-01T00:00:00Z", NOW.getTime() - 3 * DAY_MS);
  claimText(f.text);
  const r = record(id, acct, f);
  tag(id, ...tags);
  return r;
}

// --- Edge cases (newest saved first) ----------------------------------------

const startOfToday = new Date(NOW); startOfToday.setHours(0, 0, 0, 0);
const yesterdayNoon = new Date(startOfToday.getTime() - DAY_MS); yesterdayNoon.setHours(12, 0, 0, 0);

await edge(["date_today", "pfp_present"], A.alice, () => ({
  text: "Posted a few minutes before the fixture was generated. Relative dates should read as today.",
  posted: new Date(Math.max(NOW.getTime() - 5 * 60_000, startOfToday.getTime() + 1000)),
}));
await edge(["date_yesterday"], A.bob, () => ({
  text: "Posted at noon on the calendar day before the fixture was generated.",
  posted: yesterdayNoon,
}));
await edge(["date_feb29"], A.carol, () => ({
  text: "Leap-day post: February 29, 2024, at noon UTC.",
  posted: new Date("2024-02-29T12:00:00Z"),
}));
await edge(["date_dec31"], A.dave, () => ({
  text: "Last second of 2024 in UTC. In most western time zones this is still the afternoon of Dec 31.",
  posted: new Date("2024-12-31T23:59:59Z"),
}));
await edge(["date_jan1"], A.erin, () => ({
  text: "First second of 2025 in UTC. East of UTC it is already the morning of Jan 1.",
  posted: new Date("2025-01-01T00:00:01Z"),
}));
await edge(["date_dst_spring"], A.frank, () => ({
  text: "US spring-forward day, 2025-03-09: one second before 2:00 AM Eastern, when clocks jump to 3:00.",
  posted: new Date("2025-03-09T06:59:59Z"),
}));
await edge(["date_dst_fall"], A.grace, () => ({
  text: "US fall-back day, 2025-11-02: 1:30 AM Eastern, second pass, after clocks went back an hour.",
  posted: new Date("2025-11-02T06:30:00Z"),
}));

await edge(["engagement_zero"], A.heidi, () => ({
  text: "Zero engagement on every counter: replies, reposts, likes, quotes and bookmarks.",
  engagement: { likeCount: 0, repostCount: 0, replyCount: 0, quoteCount: 0, bookmarkCount: 0 },
}));
await edge(["engagement_999600"], A.alice, () => ({
  text: "Likes and bookmarks at 999,600: just under a million, where rounding to K can overflow.",
  engagement: { likeCount: 999_600, repostCount: 99_960, replyCount: 9_996, quoteCount: 999, bookmarkCount: 999_600 },
}));
await edge(["engagement_12345678"], A.bob, () => ({
  text: "Likes at 12,345,678 and other counters in the millions.",
  engagement: { likeCount: 12_345_678, repostCount: 1_234_567, replyCount: 123_456, quoteCount: 12_345, bookmarkCount: 2_345_678 },
}));

const longPost = await edge(["text_long"], A.alice, () => ({
  text: [
    "Long post, well past 280 characters, so the card truncates it and offers the full post.",
    `${paragraph(4, 4)} ${paragraph(3, 3)}`,
    `Second paragraph, separated by a blank line. ${paragraph(4, 4)}`,
    `Third paragraph. ${paragraph(3, 3)} The end of the long post.`,
  ].join("\n\n"),
}));

const URL_AT_280 = "https://example.com/fixture/a-long-path-that/keeps-going/past-the-280-character-cut?ref=fixture-data";
await edge(["text_url_at_280"], A.carol, () => ({
  text: fillTo("URL at the cut: this post runs past 280 characters and the expanded link below starts before the cut and ends after it. ", 262) +
    "https://t.co/Ur1Str4dd1 and the sentence carries on after the link, so the cut lands inside the URL.",
  links: [URL_AT_280],
}));
await edge(["text_emoji_at_280"], A.dave, () => ({
  text: fillTo("Emoji at the cut: the test tube emoji occupies UTF-16 units 279 and 280, so a slice at 280 splits its surrogate pair. ", 279) +
    "\u{1F9EA} and the text continues after the emoji, long enough to be truncated.",
}));

await edge(["text_ja", "lang_ja"], A.erin, () => ({
  language: "ja",
  text: "これはフィクスチャ用の架空の投稿です。実在の人物・団体・出来事とは一切関係ありません。漢字、ひらがな、カタカナ、全角記号（「」、。！？）が混在する文章で、フォントの読み込みと行の折り返しを確認します。",
}));
await edge(["text_zh"], A.frank, () => ({
  language: "zh",
  text: "这是一条用于测试的虚构帖子，与任何真实的人物或机构无关。简体中文与繁體中文混排，用来检查字体加载和换行是否正常。",
}));
await edge(["text_ko"], A.grace, () => ({
  language: "ko",
  text: "이것은 테스트용으로 만든 가상의 게시물입니다. 실제 인물이나 단체와는 관련이 없습니다. 한글 글꼴 로딩과 줄바꿈을 확인합니다.",
}));
await edge(["text_cyrillic"], A.heidi, () => ({
  language: "ru",
  text: "Это вымышленная запись для проверки кириллицы: шрифты, переносы и длинные слова вроде «достопримечательность» и «человеконенавистничество». Ёлка, щука, съезд — все буквы на месте.",
}));
await edge(["text_greek"], A.alice, () => ({
  language: "el",
  text: "Αυτή είναι μια φανταστική ανάρτηση για τον έλεγχο της ελληνικής γραφής: τόνοι, διαλυτικά (ϊ, ΰ) και τελικό σίγμα ς. Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.",
}));
await edge(["text_latin_ext"], A.bob, () => ({
  language: "pl",
  text: "Latin Extended check: Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy. Tiếng Việt: Đây là bài viết thử nghiệm. Türkçe: Pijamalı hasta yağız şoföre çabucak güvendi. Ångström, façade, naïve.",
}));
await edge(["text_emoji"], A.carol, () => ({
  text: "Emoji sweep: \u{1F469}\u{1F3FD}‍\u{1F52C} \u{1F9D1}‍\u{1F91D}‍\u{1F9D1} \u{1F3F3}️‍\u{1F308} \u{1F1FA}\u{1F1F3} 1️⃣ ❤️ ✨ \u{1FAE0} \u{1F980} \u{1F44D}\u{1F3FF} — ZWJ sequences, skin tones, flags, keycaps and variation selectors in one invented post.",
}));
await edge(["text_rtl_ar"], A.dave, () => ({
  language: "ar",
  text: "هذا منشور تجريبي مختلق لاختبار النص من اليمين إلى اليسار. يحتوي على رابط https://t.co/RtL0Ar4b1c ورقم 2026 وكلمة English في المنتصف.",
  links: ["https://example.org/fixture/rtl"],
}));
await edge(["text_rtl_he"], A.erin, () => ({
  language: "he",
  text: "זהו פוסט בדיוני לבדיקת טקסט מימין לשמאל, עם אזכור @fixture_bob באמצע המשפט ומספר 42.",
}));
await edge(["text_hyphen_dash"], A.frank, () => ({
  text: "Line-break check for hyphens and dashes: state-of-the-art, well-known, long-running, read-only, end-to-end, copy-on-write, right-to-left, first-in-first-out. Em-dashes without spaces—like this—and this—and one more—should break cleanly. A very-long-compound-modifier-with-many-hyphenated-segments-in-a-row tests overflow, and en-dash ranges read 2019–2026 or pp. 12–48.",
}));
await edge(["text_entities"], A.grace, () => ({
  text: "Entities: AT&amp;T, Q&amp;A, &lt;div&gt;, 5 &gt; 3 &amp;&amp; 2 &lt; 4. Escaped once more: &amp;lt;tag&amp;gt; stays as written.",
}));
await edge(["lang_und"], A.heidi, () => ({
  language: "und",
  text: "ok ok \u{1F440} 12345 +1",
}));
await edge(["lang_zxx", "media_photo_solo"], A.alice, async (ctx) => ({
  language: "zxx",
  text: "https://t.co/ZxXm3d1aOn",
  mediaObjects: [await photo(ctx, { w: 1080, h: 1350 })],
}));

await edge(["tco_glued_punct"], A.bob, () => ({
  text: "Glued punctuation around a link (https://t.co/Ab12Cd34Ef). A second one ends a clause: https://t.co/Gh56Ij78Kl, then the sentence goes on.",
  links: ["https://example.com/fixture/glued", "https://example.org/fixture/comma"],
}));
await edge(["tco_cjk_glued", "lang_ja"], A.carol, () => ({
  language: "ja",
  text: "リンクの直後に日本語が続きます https://t.co/Cj4Kg1u3dX続きの文章がスペースなしで続きます。",
  links: ["https://example.com/ja/fixture"],
}));
await edge(["tco_fewer_links"], A.dave, async (ctx) => ({
  text: "Two links and a media self-link: https://t.co/Mm1A2b3C4d and https://t.co/Mm2E5f6G7h https://t.co/MmMediaS3l",
  links: ["https://example.com/fixture/first", "https://example.org/fixture/second"],
  mediaObjects: [await photo(ctx, { w: 1200, h: 800 })],
}));
await edge(["tco_more_links"], A.erin, () => ({
  text: "One link in display form, example.com/fixture/display-f…, and one still as t.co: https://t.co/Mx9Z8y7X6w",
  links: ["https://example.com/fixture/display-form-path", "https://example.org/fixture/still-tco"],
}));

{
  const qid = nextAuxId();
  await edge(["quote_self_link_tco"], A.frank, async (ctx, id) => ({
    text: "Quote with the raw self-link still at the end https://t.co/QsL1nkAbCd",
    links: [`https://twitter.com/fixture_bob/status/${qid}`],
    quotedTweet: await quoted(id, A.bob, { id: qid, text: "Quoted post for the raw t.co self-link case.", posted: new Date("2025-06-14T09:00:00Z") }),
  }));
}
{
  const qid = nextAuxId();
  await edge(["quote_self_link_display"], A.grace, async (ctx, id) => ({
    text: "Quote with the display-form self-link at the end x.com/fixture_carol/sta…",
    links: [`https://x.com/fixture_carol/status/${qid}`],
    quotedTweet: await quoted(id, A.carol, { id: qid, text: "Quoted post for the display-form self-link case.", posted: new Date("2025-07-02T18:30:00Z") }),
  }));
}

const reply = (handles, body, acct, tags) => edge(tags, acct, () => {
  const parent = nextAuxId();
  return {
    text: `${handles.map((h) => `@${h}`).join(" ")} ${body}`,
    conversationId: parent,
    inReplyToStatusId: parent,
    inReplyToUserId: accounts.get(handles[0])?.userId ?? (1980000000000000999n).toString(),
  };
});
await reply(["fixture_bob"], "Agreed on the fixture layout; the second column reads better.", A.heidi, ["reply_1", "reply_other"]);
await reply(["fixture_bob", "fixture_carol", "fixture_dave"], "Three handles in front of a short reply body.", A.alice, ["reply_3"]);
await reply(["fixture_bob", "fixture_carol", "fixture_dave", "fixture_erin", "fixture_frank", "fixture_grace"],
  "Six handles; the pill row should wrap on a narrow card.", A.bob, ["reply_6"]);
await reply(Array.from({ length: 10 }, (_, i) => `fixture_user_${p2(i + 1)}`),
  "Ten fifteen-character handles; the pill row has to wrap onto several lines.", A.carol, ["reply_10"]);

const threadRoot = await edge(["thread_root"], A.dave, () => ({
  text: "Fixture thread, part 1 of 2. The next bookmark continues it from the same account.",
}));
await edge(["thread_self"], A.dave, () => ({
  text: "Fixture thread, part 2 of 2. A self-reply: no handles in front, but a different conversation id.",
  conversationId: threadRoot.id,
  inReplyToStatusId: threadRoot.id,
  inReplyToUserId: A.dave.userId,
}));
await edge(["mention_not_reply"], A.erin, () => ({
  text: "@fixture_carol wrote this fixture's layout notes. Starts with a mention but is not a reply.",
}));

await edge(["quote_text"], A.erin, async (ctx, id) => ({
  text: "Quoting a text-only post. The card below shows its text and no media.",
  quotedTweet: await quoted(id, A.dave, {
    text: "Quoted text-only post. Entities decode here too: R&amp;D, &lt;tag&gt;.",
    posted: new Date("2025-03-20T15:45:00Z"),
  }),
}));
await edge(["quote_1_image"], A.alice, async (ctx, id) => ({
  text: "Quoting a post with one image.",
  quotedTweet: await quoted(id, A.frank, {
    text: "Quoted post with a single photo.",
    posted: new Date("2024-10-05T08:10:00Z"),
    media: async (q) => [await photo(q, { w: 1600, h: 900 })],
  }),
}));
await edge(["quote_3_images"], A.bob, async (ctx, id) => ({
  text: "Quoting a post with three images.",
  quotedTweet: await quoted(id, A.grace, {
    text: "Quoted post with three photos.",
    posted: new Date("2024-08-17T21:00:00Z"),
    media: async (q) => [await photo(q, { w: 1200, h: 1200 }), await photo(q, { w: 1600, h: 900 }), await photo(q, { w: 900, h: 1600 })],
  }),
}));
await edge(["quote_video_poster_only"], A.carol, async (ctx, id) => ({
  text: "Quoting a post with a video. Quoted media carries no videoVariants, so only the poster is on disk.",
  quotedTweet: await quoted(id, A.heidi, {
    text: "Quoted post with a video.",
    posted: new Date("2025-01-11T12:00:00Z"),
    media: async (q) => [await videoItem(q, { variants: false })],
  }),
}));
await edge(["quote_trailing_tco"], A.dave, async (ctx, id) => ({
  text: "Quoting a post whose own text ends in its media t.co.",
  quotedTweet: await quoted(id, A.alice, {
    text: "Quoted post that ends with its media link https://t.co/QtTr4il1ng",
    posted: new Date("2025-05-05T05:05:05Z"),
    media: async (q) => [await photo(q, { w: 1200, h: 900 })],
  }),
}));
await edge(["quote_orphan"], A.erin, () => ({
  text: "Quoting a post ft could not fetch. The quote slot shows the unavailable placeholder.",
  quotedStatusId: nextAuxId(),
}));
await edge(["quote_of_bookmark"], A.frank, async (ctx, id) => ({
  text: "Quoting a post that is itself in this archive. Clicking the quote opens it here.",
  quotedTweet: await quoted(id, A.alice, { id: longPost.id, text: longPost.text, posted: new Date(Date.parse(longPost.postedAt)) }),
}));

await edge(["media_video_downloaded"], A.grace, async (ctx) => ({
  text: "Video with its top-bitrate mp4 and its poster on disk.",
  mediaObjects: [await videoItem(ctx, { mp4: "downloaded" })],
}));
await edge(["media_gif"], A.heidi, async (ctx) => ({
  text: "Animated GIF, served by X as an mp4 variant with bitrate 0.",
  mediaObjects: [await videoItem(ctx, { kind: "animated_gif", w: 320, h: 240, mp4: "downloaded" })],
}));
await edge(["media_video_skipped_too_large"], A.alice, async (ctx) => ({
  text: "Video whose mp4 ft skipped as too large (250 MB). Only the poster is on disk.",
  mediaObjects: [await videoItem(ctx, { mp4: "skipped_too_large" })],
}));
await edge(["media_video_failed"], A.bob, async (ctx) => ({
  text: "Video whose mp4 download failed (HTTP 403). Only the poster is on disk.",
  mediaObjects: [await videoItem(ctx, { mp4: "failed" })],
}));
await edge(["media_photo_placeholder"], A.carol, async (ctx) => ({
  text: "Photo that was never fetched. The card shows the placeholder.",
  mediaObjects: [await photo(ctx, { w: 1600, h: 1000, file: false })],
}));
await edge(["media_grid_2"], A.dave, async (ctx) => ({
  text: "Two-image grid.",
  mediaObjects: [await photo(ctx), await photo(ctx, { w: 1200, h: 1600 })],
}));
await edge(["media_grid_3"], A.erin, async (ctx) => ({
  text: "Three-image grid; the first image spans both rows.",
  mediaObjects: [await photo(ctx, { w: 900, h: 1600 }), await photo(ctx), await photo(ctx, { w: 1600, h: 900 })],
}));
await edge(["media_grid_4"], A.frank, async (ctx) => ({
  text: "Four-image grid, one of them a PNG.",
  mediaObjects: [await photo(ctx), await photo(ctx, { format: "png" }), await photo(ctx, { w: 1200, h: 1200 }), await photo(ctx, { w: 1600, h: 900 })],
}));
await edge(["media_no_dims"], A.grace, async (ctx) => ({
  text: "Photo with no width or height in the source data.",
  mediaObjects: [await photo(ctx, { w: 1400, h: 800, dims: false })],
}));
await edge(["media_large_thumb"], A.heidi, async (ctx) => ({
  text: "Photo file larger than 1200 px, so the server renders a thumbnail for it.",
  mediaObjects: [await photo(ctx, { w: 2400, h: 1600, fileLong: 2400 })],
}));
await edge(["color_red"], A.alice, async (ctx) => ({
  text: "Mostly red image for the color filter.",
  mediaObjects: [await photo(ctx, { img: { hue: 0, sat: 0.8, light: 0.45, spread: 0.12 } })],
}));
await edge(["color_blue"], A.bob, async (ctx) => ({
  text: "Mostly blue image for the color filter.",
  mediaObjects: [await photo(ctx, { img: { hue: 222, sat: 0.75, light: 0.45, spread: 0.12 } })],
}));
await edge(["color_grey"], A.carol, async (ctx) => ({
  text: "Greyscale image for the monochrome filter.",
  mediaObjects: [await photo(ctx, { img: { hue: 0, sat: 0, light: 0.5, spread: 0.3 } })],
}));
// Near-identical pair on two tweets: same pattern, B slightly brighter and
// re-encoded, so the bytes differ but the perceptual hashes match.
const DUP_IMG = { hue: 140, sat: 0.55, light: 0.45, spread: 0.3, seed: 424242, cols: 8, rows: 6 };
await edge(["dup_image_a"], A.dave, async (ctx) => ({
  text: "Near-duplicate image, copy A.",
  mediaObjects: [await photo(ctx, { img: DUP_IMG })],
}));
await edge(["dup_image_b"], A.erin, async (ctx) => ({
  text: "Near-duplicate image, copy B: same picture, slightly brighter, re-encoded.",
  mediaObjects: [await photo(ctx, { img: { ...DUP_IMG, shift: 5, quality: 76 } })],
}));
await edge(["pfp_missing"], A.nopfp, () => ({
  text: "Author has a profile image URL, but the file was never fetched.",
}));
await edge(["pfp_no_url"], A.nourl, () => ({
  text: "Author has no profile image URL at all.",
}));

const ARTICLE_TEXT = [
  "Synthetic archives are useful because they can be shared, screenshotted and pasted into bug reports without exposing anyone's reading history.",
  `${paragraph(4, 4)}`,
  `This article body is plain text, the way ft stores it after flattening the article blocks. ${paragraph(5, 5)}`,
  `${paragraph(4, 4)} End of the fixture article.`,
].join("\n\n");
await edge(["article_enriched"], A.grace, (ctx, id) => {
  dbRows.set(id, { primary: "research", categories: "research", articleTitle: "Fixture Article: Notes on Synthetic Archives", articleText: ARTICLE_TEXT, articleSite: null, enrichedAt: SYNCED_AT });
  return { text: "https://t.co/ArT1cLe0En", links: [`https://x.com/i/article/${tweetId(901)}`] };
});
await edge(["article_pending"], A.heidi, () => ({
  text: "https://t.co/ArT1cLe0Pd",
  links: [`https://x.com/i/article/${tweetId(902)}`],
}));
await edge(["article_non_x"], A.alice, (ctx, id) => {
  dbRows.set(id, { primary: "technique", categories: "technique", articleTitle: "Fixture blog post", articleText: "ft enriched this link, but it is not an X Article, so the server leaves it out.", articleSite: "example.com", enrichedAt: SYNCED_AT });
  return { text: "Blog post ft enriched that is not an X Article https://t.co/NoNXart1cl", links: ["https://example.com/fixture/blog/enriched-post"] };
});

await edge(["cat_primary_list"], A.bob, (ctx, id) => {
  dbRows.set(id, { primary: "tool", categories: "tool,research" });
  return { text: "Classified with a primary category and a two-item list: tool, research." };
});
await edge(["cat_unclassified"], A.carol, (ctx, id) => {
  dbRows.set(id, { primary: "unclassified", categories: null });
  return { text: "Not classified: primary_category is the literal 'unclassified', no list." };
});
await edge(["cat_primary_empty_list"], A.dave, (ctx, id) => {
  dbRows.set(id, { primary: "opinion", categories: "" });
  return { text: "Primary category set, category list empty." };
});

// Same text once t.co links and @mentions are stripped.
const DUP_BODY = "Fixture duplicate: the same sentence was posted twice with different links.";
const dupTextA = await reply(["fixture_dave"], `${DUP_BODY} https://t.co/DupAaaaaa1`, A.erin, ["dup_text_a"]);
const dupTextB = await reply(["fixture_erin", "fixture_frank"], `${DUP_BODY} https://t.co/DupBbbbbb2`, A.frank, ["dup_text_b"]);

const EDGE_COUNT = records.length;

// --- Filler -----------------------------------------------------------------

const FILLER_LANGS = [["ja", 0.05], ["zxx", 0.03], ["und", 0.02], ["es", 0.01], ["de", 0.01], ["fr", 0.01], ["pt", 0.01], ["qme", 0.005]];
const JA_PHRASES = ["フィクスチャの投稿、番号", "テスト用の文章です。項目", "架空のデータ。行番号"];
const EARLIEST = Date.parse("2021-06-01T00:00:00Z");
const fillerIds = [];

for (let i = 0; i < FILLER_COUNT; i++) {
  const id = tweetId(1000 + i);
  const acct = FILLER_ACCTS[Math.floor(FILLER_ACCTS.length * rand() ** 2)];
  const ctx = ctxFor(id, acct);
  await ensurePfp(acct, ctx);

  // Roughly newest-saved = newest-posted, with noise, from mid-2021 on.
  const span = NOW.getTime() - 2 * DAY_MS - EARLIEST;
  const t = NOW.getTime() - 2 * DAY_MS - (i / FILLER_COUNT) * span + (rand() - 0.5) * 60 * DAY_MS;
  const posted = new Date(clamp(t, EARLIEST, NOW.getTime() - DAY_MS));

  let language = "en";
  let roll = rand();
  for (const [lang, p] of FILLER_LANGS) {
    if (roll < p) { language = lang; break; }
    roll -= p;
  }

  const f = { posted, language, links: [] };
  let text;
  do {
    text = language === "ja" ? `${pick(JA_PHRASES)}${int(1, 99999)}。${paragraph(1, 1)}`
      : chance(0.15) ? `${paragraph(2, 3)}\n\n${paragraph(1, 3)}`
        : paragraph(1, 5);
  } while (!claimText(text));

  // Media
  const mediaObjects = [];
  const m = rand();
  if (language === "zxx" || m < 0.22) mediaObjects.push(await photo(ctx, { w: pick([1600, 1200, 1080]), h: pick([900, 1200, 1350]), fileLong: 640, img: chance(0.06) ? { sat: 0 } : {} }));
  else if (m < 0.25) for (let k = 0; k < 2; k++) mediaObjects.push(await photo(ctx, { fileLong: 640 }));
  else if (m < 0.27) for (let k = 0; k < 3; k++) mediaObjects.push(await photo(ctx, { fileLong: 640 }));
  else if (m < 0.29) for (let k = 0; k < 4; k++) mediaObjects.push(await photo(ctx, { fileLong: 640 }));
  else if (m < 0.32) mediaObjects.push(await photo(ctx, { file: false }));
  else if (m < 0.34) mediaObjects.push(await videoItem(ctx, { mp4: pick(["skipped_too_large", "failed", "none"]) }));
  else if (m < 0.36) mediaObjects.push(await videoItem(ctx, { mp4: "downloaded" }));
  else if (m < 0.37) mediaObjects.push(await videoItem(ctx, { kind: "animated_gif", w: 480, h: 270, mp4: "downloaded" }));
  f.mediaObjects = mediaObjects;

  // Links: legacy t.co in text, or the display form current ft writes.
  if (language !== "zxx" && chance(0.18)) {
    const url = `https://example.${pick(["com", "org", "net"])}/fixture/${pick(NOUNS)}-${int(1, 9999)}`;
    f.links.push(url);
    text += chance(0.5) ? ` https://t.co/${code(10)}` : ` ${url.replace(/^https:\/\//, "").slice(0, 26)}…`;
  }
  if (mediaObjects.length && (language === "zxx" || chance(0.6))) {
    text = language === "zxx" ? `https://t.co/${code(10)}` : `${text} https://t.co/${code(10)}`;
  }

  // Replies and self-threads
  const shape = rand();
  if (shape < 0.1 && language !== "zxx") {
    const others = FILLER_ACCTS.filter((a) => a !== acct);
    const handles = [...new Set(Array.from({ length: int(1, 3) }, () => pick(others).handle))];
    text = `${handles.map((h) => `@${h}`).join(" ")} ${text}`;
    f.conversationId = f.inReplyToStatusId = nextAuxId();
    f.inReplyToUserId = accounts.get(handles[0]).userId;
  } else if (shape < 0.14) {
    f.conversationId = f.inReplyToStatusId = nextAuxId();
    f.inReplyToUserId = acct.userId;
  }

  // Quotes: of an earlier filler bookmark, of an invented post, or orphaned.
  const q = rand();
  if (q < 0.025 && fillerIds.length > 10) {
    const targetId = pick(fillerIds);
    const target = records.find((r) => r.id === targetId);
    f.quotedTweet = {
      id: target.id, text: target.text, authorHandle: target.authorHandle, authorName: target.authorName,
      authorProfileImageUrl: target.authorProfileImageUrl, postedAt: target.postedAt,
      media: target.media, mediaObjects: target.mediaObjects, url: target.url,
    };
  } else if (q < 0.05) {
    const qa = pick(FILLER_ACCTS);
    f.quotedTweet = await quoted(id, qa, {
      text: paragraph(1, 2),
      posted: new Date(posted.getTime() - int(1, 400) * DAY_MS),
      media: async (qc) => (chance(0.3) ? [await photo(qc, { fileLong: 640 })] : []),
    });
  } else if (q < 0.055) {
    f.quotedStatusId = nextAuxId();
  }

  f.text = text;
  record(id, acct, f);
  fillerIds.push(id);
}

// --- bookmarks.jsonl --------------------------------------------------------

const lines = records.map((r) => JSON.stringify(r));
if (CORRUPT) {
  // A write cut off mid-line, the way an interrupted append leaves it.
  lines.splice(3, 0, `{"id":"${tweetId(99999)}","tweetId":"${tweetId(99999)}","text":"truncated mid-wri`);
}
writeFileSync(join(FT_DIR, "bookmarks.jsonl"), lines.join("\n") + "\n");

// --- media-manifest.json ----------------------------------------------------

const entryList = [...entries.values()];
const countStatus = (s) => entryList.filter((e) => e.status === s).length;
const manifest = {
  schemaVersion: 1,
  generatedAt: iso(NOW.getTime() - 20 * 60_000),
  limit: records.length,
  maxBytes: MAX_BYTES,
  processed: entryList.length,
  downloaded: countStatus("downloaded"),
  skippedTooLarge: countStatus("skipped_too_large"),
  failed: countStatus("failed"),
  entries: entryList,
};
writeFileSync(join(FT_DIR, "media-manifest.json"), CORRUPT ? "{}" : JSON.stringify(manifest, null, 2));

// --- bookmarks.db -----------------------------------------------------------

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5");
const SQL = await initSqlJs({ wasmBinary: readFileSync(require.resolve("sql.js-fts5/dist/sql-wasm.wasm")) });
const db = new SQL.Database();
db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY, tweet_id TEXT NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL,
  author_handle TEXT, author_name TEXT, author_profile_image_url TEXT, posted_at TEXT,
  bookmarked_at TEXT, synced_at TEXT NOT NULL, conversation_id TEXT, in_reply_to_status_id TEXT,
  quoted_status_id TEXT, language TEXT, like_count INTEGER, repost_count INTEGER,
  reply_count INTEGER, quote_count INTEGER, bookmark_count INTEGER, view_count INTEGER,
  media_count INTEGER DEFAULT 0, link_count INTEGER DEFAULT 0, links_json TEXT, tags_json TEXT,
  ingested_via TEXT, categories TEXT, primary_category TEXT, github_urls TEXT, domains TEXT,
  primary_domain TEXT, quoted_tweet_json TEXT, article_title TEXT, article_text TEXT,
  article_site TEXT, enriched_at TEXT, folder_ids TEXT, folder_names TEXT
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle)");
db.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_posted ON bookmarks(posted_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_language ON bookmarks(language)");
db.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(primary_category)");
db.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks(primary_domain)");
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  text, author_handle, author_name, article_text,
  content=bookmarks, content_rowid=rowid, tokenize='porter unicode61'
)`);
const insert = db.prepare(`INSERT INTO bookmarks VALUES (${Array(37).fill("?").join(",")})`);
const orNull = (v) => (v === undefined ? null : v);
for (const r of records) {
  const x = dbRows.get(r.id) ?? { primary: "unclassified", categories: null };
  insert.run([
    r.id, r.tweetId, r.url, r.text, r.authorHandle, r.authorName, orNull(r.authorProfileImageUrl),
    r.postedAt, r.bookmarkedAt, r.syncedAt, orNull(r.conversationId), orNull(r.inReplyToStatusId),
    orNull(r.quotedStatusId), orNull(r.language), r.engagement.likeCount, r.engagement.repostCount,
    r.engagement.replyCount, r.engagement.quoteCount, r.engagement.bookmarkCount, null,
    r.media.length, r.links.length, r.links.length ? JSON.stringify(r.links) : null, null,
    r.ingestedVia, orNull(x.categories), x.primary, null, null, null,
    r.quotedTweet ? JSON.stringify(r.quotedTweet) : null,
    orNull(x.articleTitle), orNull(x.articleText), orNull(x.articleSite), orNull(x.enrichedAt), null, null,
  ]);
}
insert.free();
db.run("INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild')");
db.run("REPLACE INTO meta VALUES ('schema_version', '6')");
writeFileSync(join(FT_DIR, "bookmarks.db"), Buffer.from(db.export()));
db.close();

// --- Cache seeds ------------------------------------------------------------

const archived = [dupTextB.id, fillerIds[5], fillerIds[17]];
tag(dupTextB.id, "archived");
writeFileSync(join(CACHE_DIR, "archived.json"), CORRUPT ? JSON.stringify({ ids: archived }) : JSON.stringify(archived));
const collections = [
  {
    id: "00000000-0000-4000-8000-000000000001", name: "Fixture reading list", createdAt: iso(NOW.getTime() - 7 * DAY_MS),
    hidden: false, ids: [longPost.id, cases.quote_text[0], cases.article_enriched[0], fillerIds[0], fillerIds[1]],
  },
  {
    id: "00000000-0000-4000-8000-000000000002", name: "Fixture hidden set", createdAt: iso(NOW.getTime() - 3 * DAY_MS),
    hidden: true, ids: [fillerIds[2], fillerIds[3], fillerIds[4]],
  },
];
writeFileSync(join(CACHE_DIR, "collections.json"), JSON.stringify(collections));
cases.collection_hidden_member = [fillerIds[2], fillerIds[3], fillerIds[4]];

// --- fixture.json (last: marks the fixture complete) ------------------------

const meta = {
  variant: CORRUPT ? "corrupt" : "default",
  generatedAt: NOW.toISOString(),
  seed: SEED,
  ffmpeg: !!(MP4.video && MP4.gif),
  counts: {
    bookmarks: records.length, edge: EDGE_COUNT, filler: FILLER_COUNT,
    mediaFiles: countStatus("downloaded"), manifestEntries: entryList.length,
  },
  archived,
  cases,
};
writeFileSync(join(ROOT, "fixture.json"), JSON.stringify(meta, null, 2));

console.log(`fixture (${meta.variant}): ${records.length} bookmarks (${EDGE_COUNT} edge cases + ${FILLER_COUNT} filler), ` +
  `${meta.counts.mediaFiles} media files, ${Object.keys(cases).length} cases`);
console.log(`  ${ROOT}`);
if (!meta.ffmpeg) console.log("  ffmpeg not found: no playable mp4s; videos and GIFs keep only their posters");
if (CORRUPT) console.log("  corrupt variant: malformed jsonl line 4, `{}` media manifest, non-array archived.json");
