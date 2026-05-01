#!/usr/bin/env node
// Lints `docs/**/*.{md,mdx}` for bare `/schemas/...` link URLs and rewrites them
// to the canonical absolute form (`https://adcontextprotocol.org/schemas/v3/...`)
// via the remark-schema-links plugin in `prod` mode.
//
// Why source-rewrite instead of a render-time wrapper: Mintlify cloud builds
// from committed MDX, so `/schemas/...` ships to users as a 404 unless the
// source is the absolute URL. The plugin handles the rewrite; this script
// applies it to `docs/` in-place.
//
// Modes:
//   --check   exit 1 if any file would be rewritten; print diff and fix command
//   --fix     rewrite in-place (default if neither flag passed)
//
// See #3634.

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSchemaUrl, BARE_PREFIX } from './remark-schema-links/plugin.mjs';

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs');
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');

// Targeted regex over inline MDX-link syntax: `](/schemas/...)`. Source
// rewrites need minimum diff, and the plugin's AST roundtrip through
// remark-stringify reformats unrelated nodes. Both code paths share the URL
// shape via resolveSchemaUrl.
//
// Coverage: inline markdown links only. The regex deliberately does NOT
// catch reference-style links (`[label]: /schemas/...`), JSX attribute
// forms (`<Card href="/schemas/...">`), or angle-bracket links — those are
// vanishingly rare in this repo's docs. The plugin's AST walk handles them
// at render time via the dev-docs wrapper.
const BARE_LINK = /\]\((\/schemas\/[^)]+)\)/g;

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

function diffLines(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      if (aLines[i] !== undefined) out.push(`- ${aLines[i]}`);
      if (bLines[i] !== undefined) out.push(`+ ${bLines[i]}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const changes = [];
  for await (const file of walk(DOCS_DIR)) {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.includes(BARE_PREFIX)) continue;
    const out = raw.replace(BARE_LINK, (_match, url) => `](${resolveSchemaUrl(url, 'prod')})`);
    if (out !== raw) changes.push({ file, raw, out });
  }

  if (changes.length === 0) {
    console.log('✓ no bare /schemas/ link rewrites needed');
    return;
  }

  if (CHECK) {
    console.error(`✗ ${changes.length} file(s) contain bare /schemas/ link URLs that need rewriting:\n`);
    for (const { file, raw, out } of changes) {
      console.error(`  ${path.relative(ROOT, file)}`);
      const d = diffLines(raw, out);
      if (d) console.error(d.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    console.error("\nBare `/schemas/...` paths break Mintlify's link checker — the absolute form is what users click.");
    console.error('Fix:  npm run fix:schema-links');
    process.exit(1);
  }

  for (const { file, out } of changes) {
    await fs.writeFile(file, out);
    console.log(`  rewrote ${path.relative(ROOT, file)}`);
  }
  console.log(`✓ rewrote ${changes.length} file(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
