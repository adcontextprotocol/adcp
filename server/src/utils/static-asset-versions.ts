/**
 * Cache-bust shared static assets referenced from served HTML.
 *
 * Root-level scripts and stylesheets (nav.js, design-system.css, ...) are
 * served with a one-day Cache-Control, and Cloudflare caches them at the edge
 * for that long. Without a version in the URL, a deploy that changes nav.js
 * can take a day to reach visitors. This rewrites `src="/x.js"` and
 * `href="/x.css"` references to `?v=<content hash>`, so every deploy that
 * changes a file changes its URL.
 */

import { readFileSync } from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

const ROOT_ASSET_REF = /\b(src|href)="(\/[A-Za-z0-9._-]+\.(?:js|css))"/g;

export function createStaticAssetVersioner(
  publicDir: string,
  options: { memoize?: boolean } = {},
): (html: string) => string {
  const memoize = options.memoize ?? process.env.NODE_ENV === 'production';
  const versions = new Map<string, string | null>();

  function versionFor(assetPath: string): string | null {
    if (memoize && versions.has(assetPath)) return versions.get(assetPath)!;
    let version: string | null = null;
    try {
      const buf = readFileSync(path.join(publicDir, assetPath.slice(1)));
      version = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
    } catch {
      version = null;
    }
    if (memoize) versions.set(assetPath, version);
    return version;
  }

  return (html: string) => html.replace(ROOT_ASSET_REF, (match, attr: string, assetPath: string) => {
    const version = versionFor(assetPath);
    return version ? `${attr}="${assetPath}?v=${version}"` : match;
  });
}
