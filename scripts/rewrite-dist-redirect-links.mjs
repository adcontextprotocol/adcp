#!/usr/bin/env node
/**
 * Apply docs.json redirects to links inside a dist/docs/<version>/ snapshot.
 *
 * Snapshot generation first rewrites /docs/foo links to
 * /dist/docs/<version>/foo. If /docs/foo is only a redirect in live docs, that
 * frozen path can point at no file. This helper rewrites those frozen links to
 * the furthest reachable redirected destination path inside the same snapshot.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function distPath(version, docsPath) {
  if (!docsPath.startsWith('/docs/')) {
    return null;
  }
  return `/dist/docs/${version}/${docsPath.slice('/docs/'.length)}`;
}

export function hasSnapshotFile(distDocsPath, exists = existsSync) {
  if (!distDocsPath?.startsWith('/dist/docs/')) {
    return false;
  }

  const localPath = distDocsPath.slice(1);
  return [
    `${localPath}.mdx`,
    `${localPath}.md`,
    `${localPath}/index.mdx`,
    `${localPath}/index.md`,
  ].some((candidate) => exists(candidate));
}

export function resolveRedirectDestination(destination, redirectMap, exists = existsSync) {
  const seen = new Set();
  let current = destination;
  let resolved = null;

  while (current && !seen.has(current)) {
    if (hasSnapshotFile(current, exists)) {
      resolved = current;
    }
    seen.add(current);
    current = redirectMap.get(current);
  }

  return resolved;
}

export function buildRedirectRules(redirects, version, exists = existsSync) {
  const rawRules = redirects
    .map((redirect) => ({
      source: distPath(version, redirect.source || ''),
      destination: distPath(version, redirect.destination || ''),
    }))
    .filter((rule) => rule.source && rule.destination);

  const redirectMap = new Map(rawRules.map((rule) => [rule.source, rule.destination]));
  return rawRules
    .map((rule) => ({
      source: rule.source,
      destination: resolveRedirectDestination(rule.destination, redirectMap, exists),
    }))
    .filter((rule) => rule.destination)
    .sort((a, b) => b.source.length - a.source.length);
}

export function rewriteContent(content, rules) {
  let rewritten = content;
  for (const { source, destination } of rules) {
    const pattern = new RegExp(`${escapeRegExp(source)}(?=([#)"'\\s<]|$))`, 'g');
    rewritten = rewritten.replace(pattern, destination);
  }
  return rewritten;
}

function main() {
  const [file, version, docsJsonPath = 'docs.json'] = process.argv.slice(2);
  if (!file || !version) {
    console.error('Usage: rewrite-dist-redirect-links.mjs <file> <version> [docs.json]');
    process.exit(2);
  }

  const config = JSON.parse(readFileSync(docsJsonPath, 'utf8'));
  const redirects = Array.isArray(config.redirects) ? config.redirects : [];
  const rules = buildRedirectRules(redirects, version);

  let content = readFileSync(file, 'utf8');
  writeFileSync(file, rewriteContent(content, rules));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
