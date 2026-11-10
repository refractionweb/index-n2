# Fixture

A synthetic fieldtheory-cli archive for running index-n2 without a real one.
Every account, post, link and image is invented, so screenshots, page text and
logs from a fixture run contain nothing private.

## Commands

| Command | Does |
|---|---|
| `npm run dev:fixture` | Generates the fixture if missing or stale, then runs the server (http://localhost:5820) and the dev client (http://localhost:5821) on it. Ctrl-C stops both. |
| `npm run fixture` | Regenerates the fixture. |
| `node scripts/check-fixture.mjs` | Verifies a running fixture server against every tagged case. Exits 1 on failure. |

Flags and environment:

| Name | Effect |
|---|---|
| `--corrupt` | `dev:fixture`, `make-fixture.mjs`, `check-fixture.mjs`: a separate variant with a malformed `bookmarks.jsonl` line, a `{}` media manifest and a non-array `archived.json`. |
| `--now <ISO date>` | `make-fixture.mjs`: pins "now" for the today / yesterday cases. |
| `FIXTURE_FT_MODE` | Fake `ft` behavior: `ok` (default), `fail` (exits 1), `hang` (stalls until Cancel), `folder-skip` / `folder-error` (with Sync X folders on: ft's skipped-folder or folder-error line, exit 0). |
| `FIXTURE_PORT`, `FIXTURE_VITE_PORT` | Server and dev-client ports. 5787 and 5173 are refused. |

## Layout

```
node_modules/.cache/index-n2-fixture/        (--corrupt: index-n2-fixture-corrupt/)
  ft-data/       ft's data directory: bookmarks.jsonl, bookmarks.db,
                 media-manifest.json, media/
  cache/         index-n2's cache directory: seeded archived.json and
                 collections.json; the server builds the rest on start
  fake-ft/       the ft stand-in, written by dev:fixture on each run
  fixture.json   case name -> bookmark ids; written last
```

`node_modules/.cache/` is ignored by git and npm. For a given `--now`, output is
identical across runs. Without `ffmpeg` on PATH, videos keep only their poster.

## Running the server by hand

`dev:fixture` sets these. A manual run on the fixture needs all of them,
including the fake `ft` first on PATH, or Sync runs the real `ft` against the
real archive.

| Variable | Read by | Meaning |
|---|---|---|
| `FT_DATA_DIR` | server.js | ft's data directory. |
| `INDEX_N2_CACHE_DIR` | server.js | index-n2's cache directory. Default `~/.index-n2`. |
| `INDEX_N2_DEV_PORT` | server.js | One more dev-client port whose origin may write. |
| `INDEX_N2_API_PORT` | vite.config.ts | Server port the dev proxy targets. Default 5787. |
| `PATH` | server.js | `node_modules/.cache/index-n2-fixture/fake-ft/bin` first. |

## Adding a case

1. In `make-fixture.mjs`, add an `edge(["case_name"], account, (ctx, id) => ({ ...fields }))`
   call. Record shapes follow ft's own code; the file header names the
   functions they mirror.
2. In `check-fixture.mjs`, add `check("case_name", ([b]) => predicate || "what was found")`.
   A tagged case with no check fails the run.
3. Run `npm run dev:fixture` (it regenerates when `make-fixture.mjs` is newer
   than the fixture), then `node scripts/check-fixture.mjs`.

## Guards

- `make-fixture.mjs` deletes and writes only under `node_modules/.cache/index-n2-fixture*`.
- `dev:fixture` refuses ports 5787 and 5173, and refuses to start unless `ft`
  on the server's PATH is the fake one.
- `check-fixture.mjs` refuses ports 5787 and 5173, and stops unless
  `/api/info` reports the fixture's media directory.
- The fake `ft` prints progress lines only: no network access, no file writes.

macOS and Linux only: the fake `ft` is a shell shim.
