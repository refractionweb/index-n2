// Paths and ports shared by the fixture scripts (make-fixture, dev-fixture,
// check-fixture, fake-ft). The fixture is a synthetic fieldtheory-cli archive
// for running index-n2 without anyone's real bookmarks.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Under node_modules/.cache/ so git and npm ignore it without a .gitignore
// entry. The corrupt variant gets its own root so both can exist side by side.
export function fixtureRoot(corrupt = false) {
  return join(REPO, "node_modules", ".cache", corrupt ? "index-n2-fixture-corrupt" : "index-n2-fixture");
}

// Off the defaults (server 5787, vite 5173) and outside the ten ports the
// server falls back through when 5787 is taken, so a fixture run never
// collides with a real one.
export const FIXTURE_PORT = Number(process.env.FIXTURE_PORT) || 5820;
export const FIXTURE_VITE_PORT = Number(process.env.FIXTURE_VITE_PORT) || 5821;
export const RESERVED_PORTS = new Set([5173, 5787]);

// The ft version the fake CLI reports: the top of server.js's tested range,
// so the About card reads "compatible" and sync controls stay enabled.
export function ftTestedMax() {
  const src = readFileSync(join(REPO, "server.js"), "utf-8");
  const m = src.match(/FT_TESTED\s*=\s*Object\.freeze\(\{\s*min:\s*"([\d.]+)",\s*max:\s*"([\d.]+)"/);
  if (!m) throw new Error("FT_TESTED not found in server.js");
  return m[2];
}
