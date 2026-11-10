#!/usr/bin/env node
// Checks a running fixture server: every case make-fixture.mjs tagged must
// come back from /api/* with the shape that case exists to exercise. Run it
// while `npm run dev:fixture` is up:
//
//   node scripts/check-fixture.mjs [--corrupt]
//
// FIXTURE_PORT selects the server (default 5820). The data is synthetic, so
// failures print the offending values in full. Exits 1 on any failure.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PORT, RESERVED_PORTS, fixtureRoot, ftTestedMax } from "./fixture-config.mjs";

const corrupt = process.argv.includes("--corrupt");
if (RESERVED_PORTS.has(FIXTURE_PORT)) {
  console.error(`check-fixture: port ${FIXTURE_PORT} is a default index-n2 / vite port, not a fixture server`);
  process.exit(2);
}
const root = fixtureRoot(corrupt);
const meta = JSON.parse(readFileSync(join(root, "fixture.json"), "utf-8"));
const base = `http://localhost:${FIXTURE_PORT}`;
const get = async (path) => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

// The fixture server must be serving the fixture, not some other archive.
// Checked before anything else is fetched.
const info = await get("/api/info");
if (!info.mediaDir.includes("index-n2-fixture")) {
  console.error(`check-fixture: server on ${FIXTURE_PORT} serves ${info.mediaDir}, not the fixture; stopping`);
  process.exit(2);
}

// The server builds colors, thumbnails and dedup after start; wait for it.
for (let i = 0; ; i++) {
  const s = await get("/api/sync-status");
  if (!s.running) break;
  if (i > 600) throw new Error("server still building caches after 5 min");
  await new Promise((r) => setTimeout(r, 500));
}

const bookmarks = await get("/api/bookmarks");
const dupes = await get("/api/duplicates");
const archive = await get("/api/archive");
const collections = await get("/api/collections");
const status = await get("/api/sync-status");
const raw = new Map(readFileSync(join(root, "ft-data", "bookmarks.jsonl"), "utf-8").split("\n")
  .filter(Boolean).flatMap((l) => { try { const r = JSON.parse(l); return [[r.id, r]]; } catch { return []; } }));
const manifestRaw = JSON.parse(readFileSync(join(root, "ft-data", "media-manifest.json"), "utf-8"));
const manifest = new Map((manifestRaw.entries ?? []).map((e) => [e.sourceUrl, e]));
const byId = new Map(bookmarks.map((b) => [b.id, b]));

// Client text pipeline, same rules as src/lib/format.ts expandTcoLinks and
// src/lib/reply-handles.ts, so position checks see what a card renders.
const expand = (text, links) => {
  let i = 0;
  return (text || "").replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, () => (i < links.length ? links[i++] : "")).trim();
};
const replyHandles = (text) => {
  const m = text.match(/^((?:@\w+(?:\s+|$))+)/);
  return m ? { handles: m[1].trim().split(/\s+/), rest: text.slice(m[0].length) } : { handles: [], rest: text };
};
const restOf = (b) => replyHandles(expand(b.text, b.links)).rest;
const tcoCount = (t) => (t.match(/https?:\/\/t\.co\/[A-Za-z0-9]+/g) || []).length;
const LEGACY = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{2}:\d{2}:\d{2} \+0000 \d{4}$/;
const chroma = (c) => Math.hypot(c.a, c.b);
const localDay = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

const results = [];
function check(name, fn) {
  const ids = meta.cases[name];
  try {
    if (ids && ids.some((id) => !byId.has(id))) throw new Error(`missing from /api/bookmarks: ${ids.filter((id) => !byId.has(id)).join(", ")}`);
    const out = fn(ids?.map((id) => byId.get(id)) ?? []);
    if (out !== true) throw new Error(typeof out === "string" ? out : "predicate false");
    results.push([name, true, ""]);
  } catch (e) {
    results.push([name, false, e.message]);
  }
}
const one = (fn) => ([b]) => fn(b);

if (corrupt) {
  check("malformed line skipped", () => bookmarks.length === meta.counts.bookmarks || `${bookmarks.length} vs ${meta.counts.bookmarks}`);
  check("{} manifest: no media mapped", () => bookmarks.every((b) => b.media.every((m) => m.url === null)) && bookmarks.every((b) => b.pfp === null));
  check("non-array archived.json served as []", () => Array.isArray(archive) && archive.length === 0 || JSON.stringify(archive));
} else {
  check("volume", () => bookmarks.length === meta.counts.bookmarks && bookmarks.length >= 1500 || `${bookmarks.length}`);
  check("date_legacy_format", () => bookmarks.every((b) => LEGACY.test(b.postedAt)) || bookmarks.find((b) => !LEGACY.test(b.postedAt)).postedAt);
  check("date_span_3y", () => {
    const years = bookmarks.map((b) => new Date(b.postedAt).getUTCFullYear());
    return Math.max(...years) - Math.min(...years) >= 3 || `${Math.min(...years)}..${Math.max(...years)}`;
  });
  const gen = new Date(meta.generatedAt);
  check("date_today", one((b) => localDay(new Date(b.postedAt)) === localDay(gen) || b.postedAt));
  check("date_yesterday", one((b) => localDay(new Date(b.postedAt)) === localDay(new Date(gen.getFullYear(), gen.getMonth(), gen.getDate() - 1)) || b.postedAt));
  check("date_feb29", one((b) => /^Thu Feb 29 .* 2024$/.test(b.postedAt) || b.postedAt));
  check("date_dec31", one((b) => /Dec 31 23:59:59 \+0000 2024$/.test(b.postedAt) || b.postedAt));
  check("date_jan1", one((b) => /Jan 01 00:00:01 \+0000 2025$/.test(b.postedAt) || b.postedAt));
  check("date_dst_spring", one((b) => /Mar 09 06:59:59 \+0000 2025$/.test(b.postedAt) || b.postedAt));
  check("date_dst_fall", one((b) => /Nov 02 06:30:00 \+0000 2025$/.test(b.postedAt) || b.postedAt));

  check("engagement_zero", one((b) => Object.values(b.engagement).every((v) => v === 0) || JSON.stringify(b.engagement)));
  check("engagement_999600", one((b) => b.engagement.likeCount === 999_600));
  check("engagement_12345678", one((b) => b.engagement.likeCount === 12_345_678));

  check("text_long", one((b) => restOf(b).length > 280 || `${restOf(b).length}`));
  check("text_url_at_280", one((b) => {
    const rest = restOf(b);
    const m = [...rest.matchAll(/https?:\/\/\S+/g)].find((x) => x.index < 280 && x.index + x[0].length > 280);
    return !!m || `no URL spans index 280 (len ${rest.length})`;
  }));
  check("text_emoji_at_280", one((b) => {
    const rest = restOf(b);
    const hi = rest.charCodeAt(279), lo = rest.charCodeAt(280);
    return (hi >= 0xd800 && hi < 0xdc00 && lo >= 0xdc00 && lo < 0xe000) || `units 279/280: ${hi.toString(16)} ${lo.toString(16)}`;
  }));
  check("text_ja", one((b) => /\p{Script=Han}/u.test(b.text) && /\p{Script=Hiragana}/u.test(b.text) && /\p{Script=Katakana}/u.test(b.text)));
  check("text_zh", one((b) => /\p{Script=Han}/u.test(b.text) && !/\p{Script=Hiragana}/u.test(b.text)));
  check("text_ko", one((b) => /\p{Script=Hangul}/u.test(b.text)));
  check("text_cyrillic", one((b) => /\p{Script=Cyrillic}/u.test(b.text)));
  check("text_greek", one((b) => /\p{Script=Greek}/u.test(b.text)));
  check("text_latin_ext", one((b) => /[ąęłńśźżčřšžůđ]/u.test(b.text)));
  check("text_emoji", one((b) => /\p{Extended_Pictographic}/u.test(b.text) && b.text.includes("‍")));
  check("text_rtl_ar", one((b) => /\p{Script=Arabic}/u.test(b.text) && b.language === "ar"));
  check("text_rtl_he", one((b) => /\p{Script=Hebrew}/u.test(b.text) && b.language === "he"));
  check("text_hyphen_dash", one((b) => b.text.includes("—") && /\w-\w+-\w/.test(b.text)));
  check("text_entities", one((b) =>
    b.text === "Entities: AT&T, Q&A, <div>, 5 > 3 && 2 < 4. Escaped once more: &lt;tag&gt; stays as written." || b.text));

  check("tco_glued_punct", one((b) => expand(b.text, b.links).includes("(https://example.com/fixture/glued).") || expand(b.text, b.links)));
  check("tco_cjk_glued", one((b) => expand(b.text, b.links).includes("https://example.com/ja/fixture続き") || expand(b.text, b.links)));
  check("tco_fewer_links", one((b) => (tcoCount(b.text) > b.links.length && b.media.length > 0) || `${tcoCount(b.text)} t.co, ${b.links.length} links`));
  check("tco_more_links", one((b) => (tcoCount(b.text) < b.links.length) || `${tcoCount(b.text)} t.co, ${b.links.length} links`));
  check("quote_self_link_tco", one((b) => (/t\.co\/\w+\s*$/.test(raw.get(b.id).text) && !b.text.includes("t.co/") && !!b.quotedTweet) || b.text));
  check("quote_self_link_display", one((b) => (/x\.com\/\S+$/.test(raw.get(b.id).text) && !/x\.com\//.test(b.text)) || b.text));

  for (const n of [1, 3, 6, 10]) {
    check(`reply_${n}`, one((b) => (replyHandles(expand(b.text, b.links)).handles.length === n && b.isThread) || b.text));
  }
  check("reply_other", one((b) => b.isThread && replyHandles(b.text).handles[0] !== `@${b.authorHandle}`));
  check("thread_root", one((b) => !b.isThread));
  check("thread_self", one((b) => b.isThread && replyHandles(b.text).handles.length === 0 && raw.get(b.id).inReplyToUserId === raw.get(b.id).author.id));
  check("mention_not_reply", one((b) => !b.isThread && replyHandles(b.text).handles.length > 0 && !raw.get(b.id).inReplyToStatusId));

  check("quote_text", one((b) => (b.quotedTweet?.text.includes("R&D, <tag>") && b.quotedTweet.media.length === 0) || JSON.stringify(b.quotedTweet)));
  check("quote_1_image", one((b) => b.quotedTweet?.media.length === 1 && !!b.quotedTweet.media[0].url));
  check("quote_3_images", one((b) => b.quotedTweet?.media.length === 3 && b.quotedTweet.media.every((m) => m.url)));
  check("quote_video_poster_only", one((b) => {
    const m = b.quotedTweet?.media[0];
    return (m?.type === "video" && m.posterOnly === true && /\.jpg$/.test(m.url)) || JSON.stringify(m);
  }));
  check("quote_trailing_tco", one((b) => (!!b.quotedTweet && !b.quotedTweet.text.includes("t.co/") && raw.get(b.id).quotedTweet.text.includes("t.co/")) || b.quotedTweet?.text));
  check("quote_orphan", one((b) => !!b.quotedStatusId && !b.quotedTweet));
  check("quote_of_bookmark", one((b) => byId.has(b.quotedTweet?.id)));

  const ffmpeg = meta.ffmpeg;
  check("media_video_downloaded", one((b) => {
    const m = b.media[0];
    if (!ffmpeg) return (m.type === "video" && m.posterOnly === true) || "no ffmpeg: expected poster only";
    return (m.type === "video" && /\.mp4$/.test(m.url) && !!m.thumb && !m.posterOnly) || JSON.stringify(m);
  }));
  check("media_gif", one((b) => {
    const m = b.media[0];
    return (m.type === "animated_gif" && (ffmpeg ? /\.mp4$/.test(m.url) : m.posterOnly)) || JSON.stringify(m);
  }));
  const variantStatus = (b) => manifest.get(raw.get(b.id).mediaObjects[0].videoVariants[0].url)?.status;
  check("media_video_skipped_too_large", one((b) => (b.media[0].posterOnly === true && variantStatus(b) === "skipped_too_large") || JSON.stringify(b.media[0])));
  check("media_video_failed", one((b) => (b.media[0].posterOnly === true && variantStatus(b) === "failed") || JSON.stringify(b.media[0])));
  check("media_photo_placeholder", one((b) => b.media[0].type === "photo" && b.media[0].url === null && b.media[0].thumb === null));
  check("media_photo_solo", one((b) => b.media.length === 1 && !!b.media[0].url));
  check("media_grid_2", one((b) => b.media.length === 2 && b.media.every((m) => m.url)));
  check("media_grid_3", one((b) => b.media.length === 3 && b.media.every((m) => m.url)));
  check("media_grid_4", one((b) => b.media.length === 4 && b.media.every((m) => m.url) && b.media.some((m) => m.url.endsWith(".png"))));
  check("media_no_dims", one((b) => (b.media[0].width == null && b.media[0].height == null && !!b.media[0].url) || JSON.stringify(b.media[0])));
  check("media_large_thumb", one((b) => b.media[0].thumb?.startsWith("/thumbs/") || JSON.stringify(b.media[0])));

  check("pfp_present", one((b) => b.pfp?.startsWith("/media/")));
  check("pfp_missing", one((b) => b.pfp === null && !!raw.get(b.id).authorProfileImageUrl));
  check("pfp_no_url", one((b) => b.pfp === null && !raw.get(b.id).authorProfileImageUrl));

  const top = (b) => b.media[0].colors?.palette[0];
  check("color_red", one((b) => (top(b) && top(b).a > 35 && Math.abs(top(b).b) < top(b).a) || JSON.stringify(b.media[0].colors)));
  check("color_blue", one((b) => (top(b) && top(b).b < -30) || JSON.stringify(b.media[0].colors)));
  check("color_grey", one((b) => (b.media[0].colors && b.media[0].colors.avgChroma < 12 && b.media[0].colors.palette.every((c) => chroma(c) < 12)) || JSON.stringify(b.media[0].colors)));

  const groupCheck = (groups, a, b, label) => {
    const g = groups.find((grp) => grp.some((x) => x === a || x.startsWith(a + "-")) && grp.some((x) => x === b || x.startsWith(b + "-")));
    return (!!g && groups.length === 1) || `${label} groups: ${JSON.stringify(groups)}`;
  };
  const [imgA] = meta.cases.dup_image_a, [imgB] = meta.cases.dup_image_b;
  const [txtA] = meta.cases.dup_text_a, [txtB] = meta.cases.dup_text_b;
  check("dup_image_a", () => groupCheck(dupes.imageDupes, imgA, imgB, "image"));
  check("dup_image_b", () => groupCheck(dupes.imageDupes, imgA, imgB, "image"));
  check("dup_text_a", () => groupCheck(dupes.textDupes, txtA, txtB, "text"));
  check("dup_text_b", () => groupCheck(dupes.textDupes, txtA, txtB, "text"));

  check("article_enriched", one((b) => !!b.article?.title && b.article.text.length > 0));
  check("article_pending", one((b) => b.article === null && b.links.some((l) => l.includes("/i/article/"))));
  check("article_non_x", one((b) => b.article === null));

  check("cat_primary_list", one((b) => (b.primary_category === "tool" && JSON.stringify(b.categories) === '["tool","research"]') || `${b.primary_category} ${JSON.stringify(b.categories)}`));
  check("cat_unclassified", one((b) => b.primary_category === null && b.categories.length === 0));
  check("cat_primary_empty_list", one((b) => (b.primary_category === "opinion" && b.categories.length === 0) || `${b.primary_category} ${JSON.stringify(b.categories)}`));

  for (const lang of ["en", "ja", "zxx", "und"]) {
    check(`lang_${lang}`, () => bookmarks.some((b) => b.language === lang));
  }

  check("archived", ([b]) => archive.includes(b.id) && meta.archived.every((id) => archive.includes(id)) || JSON.stringify(archive));
  check("collections", () => (collections.length === 2 && collections.filter((c) => c.hidden).length === 1) || JSON.stringify(collections));
  check("collection_hidden_member", (bs) => bs.length === 3 && collections.find((c) => c.hidden).ids.every((id) => meta.cases.collection_hidden_member.includes(id)));
  check("unfetched_count", () => status.unfetchedCount > 0 || `${status.unfetchedCount}`);
  check("ft_version", () => (info.ft?.version === ftTestedMax() && info.ft.status === "compatible") || JSON.stringify(info.ft));

  const covered = new Set(results.map(([n]) => n));
  for (const name of Object.keys(meta.cases)) {
    if (!covered.has(name)) results.push([name, false, "tagged by make-fixture but not checked"]);
  }
}

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, msg] of results) console.log(`${ok ? "pass" : "FAIL"}  ${name}${msg ? `  ${msg}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
