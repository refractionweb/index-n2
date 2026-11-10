#!/usr/bin/env node
// Stand-in for the fieldtheory CLI (`ft`) in fixture runs. dev-fixture.mjs
// puts a shim for it first on the server's PATH, next to a package.json
// named "fieldtheory", so the server's version check and its `ft` spawns
// both land here instead of on a real install.
//
// It prints progress frames shaped like ft's spinner (carriage-return
// frames on stderr, "Syncing bookmarks...  N new  │  page M  │  Ts") for the
// server's output parsers, and does nothing else: no network, no file
// writes, no reads outside this repo. The fixture data stays as generated.
//
// FIXTURE_FT_MODE picks the behavior:
//   ok    (default) frames for each phase, then exit 0
//   fail  one frame, an error line, exit 1
//   hang  one frame, then silence until killed (SIGINT exits like ft does)
//   folder-skip   with --folders: ft's "⚠ Skipped <name>: <reason>" line for a
//                 folder whose name contains ": ", then exit 0 as ft does
//   folder-error  with --folders: ft's "Folder sync error: <msg>" line in place
//                 of the folder walks, then exit 0 as ft does

import { ftTestedMax } from "./fixture-config.mjs";

const MODE = process.env.FIXTURE_FT_MODE || "ok";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

const args = process.argv.slice(2);
const command = args[0];
const has = (flag) => args.includes(flag);

let spin = 0;
const frame = (line) => process.stderr.write(`\r\x1b[K  ${SPINNER[spin++ % SPINNER.length]} ${line}`);
const endFrames = () => process.stderr.write("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ft's spinner catches SIGINT, prints a notice and exits 0.
process.on("SIGINT", () => {
  endFrames();
  console.log("  Interrupted. Fixture ft wrote nothing.");
  process.exit(0);
});

async function phase(lines) {
  if (MODE === "fail") {
    frame(lines[0]);
    endFrames();
    process.stderr.write("Error: simulated failure (FIXTURE_FT_MODE=fail)\n");
    process.exit(1);
  }
  if (MODE === "hang") {
    frame(lines[0]);
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
  for (const line of lines) {
    frame(line);
    await sleep(FRAME_MS);
  }
  endFrames();
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

async function sync() {
  if (has("--gaps")) {
    process.stderr.write("  Filling gaps (quoted tweets, truncated text, articles)...\n");
    const total = 12;
    await phase(range(total + 1).map((done) => {
      const parts = [`${done}/${total} (${Math.round((done / total) * 100)}%)`];
      if (done >= 4) parts.push("1 quoted");
      if (done >= 7) parts.push("2 expanded");
      if (done >= 9) parts.push("1 articles");
      if (done >= 11) parts.push("1 failed");
      parts.push(`${Math.floor(done / 4)}s`);
      return parts.join(" │ ");
    }));
    console.log("  Gaps checked: 12. Fixture ft wrote nothing.");
    return;
  }
  await phase(range(8).map((i) =>
    `Syncing bookmarks...  ${Math.min(i, 3)} new  │  page ${1 + Math.floor(i / 4)}  │  ${Math.floor(i / 3)}s`));
  if (has("--folders")) {
    // ft's folder phase: a header on stderr, one "→ <name>..." line per
    // folder, nothing during a walk, then per-folder summaries on stdout.
    process.stderr.write("\n  Syncing bookmark folders...\n");
    if (MODE === "folder-error") {
      // ft's catch around the whole folder phase (cli.ts): no walks, no
      // summaries, exit 0.
      process.stderr.write("\n  Folder sync error: BookmarkFoldersSlice API returned 403.\n\n");
    }
    for (const name of MODE === "folder-error" ? [] : ["Fixture design refs", "Fixture to read"]) {
      process.stderr.write(`  \u2192 ${name}...\n`);
      await sleep(FRAME_MS * 4);
    }
    if (MODE !== "folder-error") {
      console.log("");
      console.log(`  \u2713 ${"Fixture design refs".padEnd(24)}  13 unchanged`);
      console.log(`  \u2713 ${"Fixture to read".padEnd(24)}  9 unchanged`);
    }
    if (MODE === "folder-skip") {
      console.log("");
      console.log("  \u26a0 Skipped Fixture ratio: 16:9 refs: walk incomplete (rate limited)");
      console.log("  Re-run `ft sync --folders` to retry.");
    }
    console.log("");
  }
  if (!has("--no-media")) {
    await phase(range(10).map((i) =>
      `Fetching media...  ${i} processed  │  ${Math.max(0, i - 1)} downloaded  │  ${Math.floor(i / 3)}s`));
  }
  process.stderr.write("  Building search index...\n");
  await sleep(FRAME_MS * 3);
  console.log("  3 new bookmarks reported. Fixture ft wrote nothing.");
}

async function fetchMedia() {
  await phase(range(10).map((i) =>
    `Fetching media...  ${i} processed  │  ${Math.max(0, i - 2)} downloaded  │  ${Math.floor(i / 3)}s`));
  console.log("  7 downloaded / 2 failed reported. Fixture ft wrote nothing.");
}

if (command === "sync") await sync();
else if (command === "fetch-media") await fetchMedia();
else if (command === "--version" || command === "-V") console.log(ftTestedMax());
else {
  process.stderr.write(`fixture ft: unsupported command: ${args.join(" ") || "(none)"}\n`);
  process.exit(1);
}
