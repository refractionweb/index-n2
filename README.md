# index-n2

https://github.com/user-attachments/assets/f25b8ad1-d227-4c5d-9487-09ad5590febb

A local viewer for [fieldtheory-cli](https://github.com/afar1/fieldtheory-cli). Runs a Node server on `localhost:5787` and opens a browser tab. Reads from ft's data directory; writes derived caches to `~/.index-n2/`.

Third-party tool, not affiliated with fieldtheory-cli.

Available for Macintosh, Linux and Windows systems. On Windows, sync runs through Firefox; other browsers aren't supported there. (Manual cookie paste and the paid X API work anywhere.)

## Install

```sh
npm install -g index-n2
```

Requires [Node.js](https://nodejs.org) and a working [fieldtheory-cli](https://github.com/afar1/fieldtheory-cli) install on PATH. No bookmark data needed up front — first sync runs from the sidebar.

## Run

```sh
index-n2
```

The server binds `127.0.0.1:5787` and opens `http://localhost:5787/`. If 5787 is taken it walks up to 5797. Stop with Ctrl-C.

## Overview

Reads ft's `bookmarks.jsonl` and `bookmarks.db` directly from its data directory (see [Layout](#layout)). Renders the result as a masonry grid, gallery, lightbox, and duplicates view. Filters across author, type, language, category, color, and full-text search. Wraps `ft sync`, `ft fetch-media`, and `ft sync --rebuild` as sidebar actions with live progress over Server-Sent Events.

ft's data directory is treated as read-only. The GUI never writes, deletes, or modifies anything inside it. All derived data — thumbnails, color palette cache, dedup index, archive list, settings — lives in `~/.index-n2/` and is rebuildable from scratch.

### CLI features re-implemented client-side

| Feature             | CLI equivalent       |
| ------------------- | -------------------- |
| Full-text search    | `ft search`          |
| Filter by author    | `ft list --author`   |
| Filter by category  | `ft list --category` |
| Sort by date        | `ft list --sort`     |

### CLI commands wrapped

| Action            | Shells out to                   |
| ----------------- | ------------------------------- |
| Sync All          | `ft sync` then `ft fetch-media` |
| Sync Bookmarks    | `ft sync`                       |
| Fetch Media       | `ft fetch-media --limit N`      |
| Rebuild Bookmarks | `ft sync --rebuild --yes`       |

### GUI-original

- **Color filter.** A dominant palette is extracted per image (median-cut RGB quantization, palette stored in Lab D65 for matching) and cached on disk. A picked hex matches palette entries via population-weighted ΔE with a lightness-aware threshold; a separate mono mode matches images whose chroma falls below ~12.
- **Duplicate detection.** 64-bit pHash (32×32 → 2D DCT → 8×8 low-frequency block, median threshold) with a 9-bit Hamming radius for images; exact-match grouping over normalized text. Profile pictures and solid-color images are excluded.
- **Type filter** — text, image, video, gif, link, quoted, thread.
- **Sort by engagement** — likes, reposts, bookmarks, or random.
- **Gallery view.** Image-only, flattened across bookmarks.
- **Archive.** Hide bookmarks from the main grid without touching source data.

## Configuration

### In-app settings

Persisted in `~/.index-n2/settings.json`. Edit through the gear icon in the sidebar.

| Key                 | Default | Effect                                              |
| ------------------- | ------- | --------------------------------------------------- |
| `theme`             | system  | system / light / dark                               |
| `autoplayVideos`    | true    | Auto-start videos in the lightbox                   |
| `autoOpenBrowser`   | true    | Open a browser tab on startup (restart to apply)    |
| `skipMedia`         | false   | Sync runs `ft sync --no-media` (bookmarks only)     |
| `mediaFetchLimit`   | 0       | Cap for `ft fetch-media --limit`. 0 disables it.    |
| `skipProfileImages` | false   | Adds `--skip-profile-images` to `ft fetch-media`    |
| `hideUnfetched`     | false   | Hide bookmarks with media pending download          |

Two additional keys are flipped by "Don't show this again" checkboxes on confirmation dialogs, not the gear icon: `cancelMediaWarningSuppressed` (cancel fetch-media) and `noLimitWarningSuppressed` (no-batch-limit warning shown before unbounded Sync / Fetch Media). Reset to Defaults clears all nine.

Unknown keys are stripped on the next save; defaults backfill missing keys. Schema migrations are self-healing.

### Environment

| Variable       | Default           | Effect                                                   |
| -------------- | ----------------- | -------------------------------------------------------- |
| `FT_DATA_DIR`  | ft's default      | Override the ft data directory. Unset, resolved as ft does: `~/.fieldtheory/bookmarks`, or `~/.ft-bookmarks` when only that exists. |
| `PORT`         | 5787              | Pin the port. Disables the auto-fallback on collision.   |
| `BROWSER=none` | unset             | Skip browser auto-open even if the setting is enabled    |
| `CI`           | unset             | Skip browser auto-open                                   |

### Flags

```
index-n2 --no-open      Skip browser auto-open for this run
```

## Layout

```
~/.fieldtheory/bookmarks/         fieldtheory-cli, read-only to this app
                                  (~/.ft-bookmarks/ on older installs)
  bookmarks.jsonl                 raw bookmark records
  bookmarks.db                    SQLite, opened read-only via sql.js-fts5
  media-manifest.json             URL → local-path map
  media/                          downloaded media

~/.index-n2/              derived; safe to delete and rebuild
  thumbnails/                     1200px JPEGs (only for media > 1200px)
  colors.json                     per-image Lab palettes
  dedup.json                      pHash + text-match cache
  archived.json                   archived bookmark IDs
  settings.json                   user settings

index-n2 process          localhost:5787
  server.js                       API + static + media + image pipeline
  dist/                           Vite build (React 19, TS, Tailwind 4, shadcn/ui)
```

Per-file caches (palette, pHash, thumbnails) are keyed by media filename and grow incrementally — only files in ft's `media/` directory that aren't already in the cache trigger work. Bookmark records reload when `bookmarks.jsonl` or the SQLite mtime changes.

## Security

The server is a localhost-only Node process. Defenses:

- **Bind to 127.0.0.1.**
- **Host-header validation.** Every request must carry a loopback `Host` (`localhost` / `127.0.0.1`). Anything else — e.g. a DNS-rebound hostname — returns 403.
- **Origin check on writes.** Every mutating endpoint requires an `Origin` header matching the server's own origin (or the vite dev client's). Cross-origin POSTs — including from other localhost ports — return 403.
- **Path traversal + symlink escape guard.** Every static-file request — `/media/`, `/thumbs/`, and the SPA bundle in `dist/` — is resolved lexically, then `realpath`-validated to lie under its base directory.
- **Media extension whitelist.** Image and video formats only — no SVG, no HTML.
- **Strict CSP.** No remote scripts; the only inline script is hash-allowlisted. Styles, images, fonts, and media follow standard SPA carve-outs.
- **Subprocess discipline.** Spawned `ft` processes time out at 5 min idle (not wall-clock). Cancel sends SIGINT on Unix.

No remote endpoints are contacted. All media is read from ft's `media/` directory, which ft itself populates.

## Limitations

- Categories are read-only. No in-app classification editor.
- Cancelling `ft fetch-media` mid-run leaves orphaned files on disk: ft writes its manifest at end-of-run, so a cancelled batch's downloads are invisible to ft and re-fetched next time. Bandwidth waste, no corruption. Tracked upstream.
- A small set of permanently unfetchable URLs (deleted tweets, protected accounts) keep the "N unfetched" badge non-zero.

## Development

```sh
git clone https://github.com/refractionweb/index-n2.git
cd index-n2
npm install
```

Two-process dev loop:

```sh
node server.js      # API on :5787
npm run dev         # Vite on :5173, proxies /api /media /thumbs to :5787
```

Production build:

```sh
npm run build       # tsc -b && vite build
npm start           # serves dist/ from server.js
```

Other tasks:

```sh
npm run typecheck
npm run lint
npm run format
```

The codebase is React 19 + TypeScript + Vite + Tailwind 4 + shadcn/ui. State is React Context + `useReducer`, split per concern under `src/contexts/`. No Redux, no Zustand. Path imports use `@/` for `src/`. Styling sticks to shadcn semantic tokens; deviations are recorded inline next to the code that needs them.

## Credits

Built on open source:

- [React](https://react.dev) · [Vite](https://vite.dev) · [TypeScript](https://www.typescriptlang.org) — MIT
- [Tailwind CSS](https://tailwindcss.com) · [shadcn/ui](https://ui.shadcn.com) · [Radix UI](https://www.radix-ui.com) — MIT
- [cmdk](https://cmdk.paco.me) · [open](https://github.com/sindresorhus/open) · [quantize](https://github.com/olivierlesnicki/quantize) · [clsx](https://github.com/lukeed/clsx) · [tailwind-merge](https://github.com/dcastil/tailwind-merge) — MIT
- [sharp](https://sharp.pixelplumbing.com) · [class-variance-authority](https://cva.style) — Apache-2.0
- [sql.js-fts5](https://github.com/dchest/sql.js-fts5) — MIT
- [Remix Icon](https://remixicon.com) — [Remix Icon License 1.0](https://github.com/Remix-Design/RemixIcon/blob/master/License)
- [Inter](https://fonts.google.com/specimen/Inter) by Rasmus Andersson — [OFL-1.1](https://openfontlicense.org)

## License

[MIT License](./LICENSE) · Copyright © 2026 [Refraction](https://refraction.studio)
