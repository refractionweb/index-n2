#!/usr/bin/env node
// `npm run dev:fixture`: the dev setup (server + vite) on the synthetic
// fixture instead of ~/.ft-bookmarks and ~/.index-n2.
//
//   1. Generates the fixture if it is missing or older than make-fixture.mjs.
//   2. Writes the fake ft shim: bin/ft plus a package.json named
//      "fieldtheory", so the server's version check accepts it and Sync /
//      Fetch Media spawn it instead of a real ft.
//   3. Starts server.js on FIXTURE_PORT (default 5820) with FT_DATA_DIR and
//      INDEX_N2_CACHE_DIR inside the fixture, the shim first on PATH, and
//      INDEX_N2_DEV_PORT so writes from the vite origin pass its check.
//   4. Starts vite on FIXTURE_VITE_PORT (default 5821), proxying to it.
//
// Flags: --corrupt runs the corrupt variant. FIXTURE_FT_MODE=ok|fail|hang
// sets the fake ft's behavior (see fake-ft.mjs). Ctrl-C stops both.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { FIXTURE_PORT, FIXTURE_VITE_PORT, REPO, RESERVED_PORTS, fixtureRoot, ftTestedMax } from "./fixture-config.mjs";

const corrupt = process.argv.includes("--corrupt");
const root = fixtureRoot(corrupt);
const rel = (p) => relative(REPO, p) || ".";

for (const port of [FIXTURE_PORT, FIXTURE_VITE_PORT]) {
  if (RESERVED_PORTS.has(port)) {
    console.error(`dev:fixture: port ${port} is a default index-n2 / vite port; pick another`);
    process.exit(2);
  }
}

const generator = join(REPO, "scripts", "make-fixture.mjs");
const stamp = join(root, "fixture.json");
if (!existsSync(stamp) || statSync(stamp).mtimeMs < statSync(generator).mtimeMs) {
  const res = spawnSync(process.execPath, [generator, ...(corrupt ? ["--corrupt"] : [])], { cwd: REPO, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// The shim calls this node binary by absolute path, so it works whatever
// else is on PATH. Rewritten every run to track server.js's FT_TESTED.
const ftDir = join(root, "fake-ft");
const ftBin = join(ftDir, "bin");
mkdirSync(ftBin, { recursive: true });
writeFileSync(join(ftDir, "package.json"), JSON.stringify({
  name: "fieldtheory",
  version: ftTestedMax(),
  private: true,
  description: "Fixture stand-in for the ft CLI. Not the real package.",
}, null, 2) + "\n");
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(join(ftBin, "ft"),
  `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(join(REPO, "scripts", "fake-ft.mjs"))} "$@"\n`);
chmodSync(join(ftBin, "ft"), 0o755);

const serverEnv = {
  ...process.env,
  FT_DATA_DIR: join(root, "ft-data"),
  INDEX_N2_CACHE_DIR: join(root, "cache"),
  PORT: String(FIXTURE_PORT),
  INDEX_N2_DEV_PORT: String(FIXTURE_VITE_PORT),
  PATH: `${ftBin}${delimiter}${process.env.PATH ?? ""}`,
  BROWSER: "none",
};
// The server's ft detection tries module resolution before PATH; a NODE_PATH
// reaching a real global install would report that version instead.
delete serverEnv.NODE_PATH;

// If the shim isn't the first `ft` on the server's PATH, Sync would spawn a
// real install, which syncs the real archive. Refuse to start instead.
const firstFt = serverEnv.PATH.split(delimiter)
  .filter(Boolean)
  .map((dir) => join(dir, "ft"))
  .find((p) => existsSync(p));
if (firstFt !== join(ftBin, "ft")) {
  console.error(`dev:fixture: \`ft\` on the server's PATH is ${firstFt ?? "missing"}, not the fixture shim; stopping`);
  process.exit(2);
}

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  process.exitCode = code;
}
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`dev:fixture: ${name} exited (${signal ?? code}); stopping`);
    stop(code ?? 1);
  });
  children.push(child);
}

console.log(`dev:fixture: data ${rel(root)}${corrupt ? " (corrupt variant)" : ""}, ft mode ${process.env.FIXTURE_FT_MODE || "ok"}`);
console.log(`dev:fixture: app http://localhost:${FIXTURE_VITE_PORT}  server http://localhost:${FIXTURE_PORT}`);

start("server", [join(REPO, "server.js"), "--no-open"], serverEnv);
start("vite", [join(REPO, "node_modules", "vite", "bin", "vite.js"), "--port", String(FIXTURE_VITE_PORT), "--strictPort", "--clearScreen", "false"],
  { ...process.env, INDEX_N2_API_PORT: String(FIXTURE_PORT) });

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(0));
