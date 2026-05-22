#!/usr/bin/env node
/**
 * Apply docs.json redirects to links inside a dist/docs/<version>/ snapshot.
 *
 * Snapshot generation first rewrites /docs/foo links to
 * /dist/docs/<version>/foo. If /docs/foo is only a redirect in live docs, that
 * frozen path can point at no file. This helper rewrites those frozen links to
 * the redirected destination path inside the same snapshot.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function distPath(version, docsPath) {
  if (!docsPath.startsWith('/docs/')) {
    return null;
  }
  return `/dist/docs/${version}/${docsPath.slice('/docs/'.length)}`;
}

function main() {
  const [file, version, docsJsonPath = 'docs.json'] = process.argv.slice(2);
  if (!file || !version) {
    console.error('Usage: rewrite-dist-redirect-links.mjs <file> <version> [docs.json]');
    process.exit(2);
  }

  const config = JSON.parse(readFileSync(docsJsonPath, 'utf8'));
  const redirects = Array.isArray(config.redirects) ? config.redirects : [];
  const rules = redirects
    .map((redirect) => ({
      source: distPath(version, redirect.source || ''),
      destination: distPath(version, redirect.destination || ''),
    }))
    .filter((rule) => rule.source && rule.destination)
    .sort((a, b) => b.source.length - a.source.length);

  let content = readFileSync(file, 'utf8');
  for (const { source, destination } of rules) {
    const pattern = new RegExp(`${escapeRegExp(source)}(?=([#)"'\\s<]|$))`, 'g');
    content = content.replace(pattern, destination);
  }

  writeFileSync(file, content);
}

main();
