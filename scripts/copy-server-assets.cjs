#!/usr/bin/env node
// Mirror non-TypeScript runtime assets from server/src/** into dist/**.
// `tsc` only emits .js from .ts, so any module that does
//   require('./foo.json') / readFile(__dirname + '/foo.sql')
// will ENOENT at runtime in the built image unless the asset is copied here.
// Establishing this in the npm build script (rather than in the Dockerfile)
// means `node dist/index.js` works locally too, and CI exercises the same
// asset graph the runtime image ships.
//
// Extensions are an explicit allowlist: any non-TS file type that needs to
// reach dist should be added here. The allowlist is intentionally permissive
// so contributors don't have to remember to opt-in when adding a new asset.
//
// Modes:
//   (default)  Copy every allowlisted src asset into the matching dist path.
//   --check    Don't copy. Exit non-zero if any src asset is missing in dist
//              (verifies the build script ran and the contract holds — the
//              CI assertion that catches PR #4769-class regressions).

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "server", "src");
const DST = path.join(__dirname, "..", "dist");
const EXTENSIONS = new Set([".json", ".md", ".sql", ".txt", ".csv", ".yaml", ".yml", ".html", ".xml"]);
const checkMode = process.argv.includes("--check");

const assets = [];

function walk(dir, relBase = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relBase, entry.name);
    const src = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(src, rel);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      assets.push({ rel, src });
    }
  }
}

walk(SRC);

if (checkMode) {
  const missing = assets.filter(({ rel }) => !fs.existsSync(path.join(DST, rel)));
  if (missing.length > 0) {
    console.error(`copy-server-assets --check: ${missing.length} asset(s) missing in dist/:`);
    for (const { rel } of missing) console.error(`  server/src/${rel} -> dist/${rel}`);
    console.error("\nRun `npm run build` to refresh dist/, or update the EXTENSIONS allowlist if a new file type was introduced.");
    process.exit(1);
  }
  console.log(`copy-server-assets --check: ${assets.length} asset(s) present in dist`);
} else {
  for (const { rel, src } of assets) {
    const dst = path.join(DST, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  console.log(`copy-server-assets: ${assets.length} file(s) copied from server/src to dist`);
}
