#!/usr/bin/env node
// Wraps `mintlify dev` so /schemas/... and post-autofix absolute prod URLs
// rewrite to localhost during local preview. Lets contributors working on
// in-flight schema fields click through to the local schema host instead of
// hitting prod (which doesn't have the new field yet). See #3634.
//
// Layout: stage docs.json + a rewritten copy of docs/ in `.mintlify-dev/`,
// copy small read-only dirs (static, logo, public, specs), symlink large
// ones (images, dist). Mintlify's OpenAPI loader doesn't follow symlinks
// (`fs.existsSync` without realpath), so anything its loaders touch must be
// a real path; the linkable assets that go through its static-file middleware
// can stay symlinked. The staging dir lives next to the repo root (not /tmp)
// because Mintlify computes cwd-relative paths to symlink targets and chokes
// on long `../../../` chains spanning the filesystem.
//
// chokidar watches docs/ and re-rewrites changed MDX into the staging copy
// so Mintlify's own watcher picks them up. Cleanup on SIGINT/SIGTERM/exit.
//
// Usage:
//   npm run dev:docs
//   PORT=3001 npm run dev:docs

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';
import { resolveSchemaUrl, BARE_PREFIX, PROD_PREFIX } from './remark-schema-links/plugin.mjs';

const ROOT = process.cwd();
const STAGING = path.join(ROOT, '.mintlify-dev');
const DOCS_SRC = path.join(ROOT, 'docs');
const DOCS_DST = path.join(STAGING, 'docs');

const HTTP_PORT = parseInt(process.env.CONDUCTOR_PORT ?? process.env.PORT ?? '3000', 10);
const MINTLIFY_PORT = HTTP_PORT + 1;

// Rewrite both bare paths and absolute-prod URLs in inline markdown links.
// Same coverage trade-off as lint-schema-links.mjs — inline links only;
// the AST plugin runs alongside Mintlify for JSX/reference cases via the
// remark default export, but this regex pass handles the common cases
// without the remark-stringify reformat noise.
const BARE_LINK_RE = /\]\((\/schemas\/[^)]+)\)/g;
const ABSOLUTE_LINK_RE = new RegExp(`\\]\\((${escapeRegex(PROD_PREFIX)}[^)]+)\\)`, 'g');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteForDev(raw) {
  if (!raw.includes(BARE_PREFIX) && !raw.includes(PROD_PREFIX)) return raw;
  return raw
    .replace(BARE_LINK_RE, (_m, url) => `](${resolveSchemaUrl(url, 'dev')})`)
    .replace(ABSOLUTE_LINK_RE, (_m, url) => `](${resolveSchemaUrl(url, 'dev')})`);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function setupStaging() {
  await fs.rm(STAGING, { recursive: true, force: true });
  await fs.mkdir(STAGING, { recursive: true });

  // docs.json: copy (small, infrequently changed; restart picks up edits).
  await fs.copyFile(path.join(ROOT, 'docs.json'), path.join(STAGING, 'docs.json'));

  // Mintlify loaders that bypass symlinks (OpenAPI source resolution) need
  // real files — copy those. Static-file middleware follows symlinks fine,
  // so large dirs stay symlinked to keep boot cheap.
  const COPY = ['static', 'logo', 'snippets', 'public', 'specs'];
  const SYMLINK = ['images', 'dist'];
  for (const entry of COPY) {
    if (await exists(path.join(ROOT, entry))) {
      // dereference: true materializes any nested symlinks as real files;
      // Mintlify's no-realpath existsSync would otherwise reject them.
      await fs.cp(path.join(ROOT, entry), path.join(STAGING, entry), {
        recursive: true,
        dereference: true,
      });
    }
  }
  for (const entry of SYMLINK) {
    if (await exists(path.join(ROOT, entry))) {
      await fs.symlink(path.join('..', entry), path.join(STAGING, entry));
    }
  }

  // docs/: mirror with rewrite.
  await mirrorDocs(DOCS_SRC, DOCS_DST);
}

async function mirrorDocs(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) return mirrorDocs(s, d);
    if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      const raw = await fs.readFile(s, 'utf8');
      await fs.writeFile(d, rewriteForDev(raw));
    } else {
      await fs.copyFile(s, d);
    }
  }));
}

async function syncOne(srcPath) {
  const rel = path.relative(DOCS_SRC, srcPath);
  const dst = path.join(DOCS_DST, rel);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  if (srcPath.endsWith('.mdx') || srcPath.endsWith('.md')) {
    const raw = await fs.readFile(srcPath, 'utf8');
    await fs.writeFile(dst, rewriteForDev(raw));
  } else {
    await fs.copyFile(srcPath, dst);
  }
}

async function unlinkOne(srcPath) {
  const rel = path.relative(DOCS_SRC, srcPath);
  await fs.rm(path.join(DOCS_DST, rel), { force: true, recursive: true });
}

async function preflight() {
  // Surface the most common silent failure: dev-mode rewrites point at
  // localhost:3000/schemas/latest/..., which is served by `npm start`. If
  // that's not running, every schema link in the preview will 404.
  try {
    const res = await fetch('http://localhost:3000/schemas/latest/', {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok && res.status !== 404 && res.status !== 301) {
      console.warn(`⚠  localhost:3000 responded ${res.status} — schema links in preview may 404. Run 'npm start' in another terminal.`);
    }
  } catch {
    console.warn("⚠  no schema host on localhost:3000 — schema links in preview will 404. Run 'npm start' in another terminal.");
  }
}

async function main() {
  console.log('🛠  staging docs/ to .mintlify-dev/ ...');
  try {
    await setupStaging();
  } catch (err) {
    console.error('✗ staging failed (check permissions / disk space):', err.message);
    process.exit(1);
  }
  await preflight();

  const watcher = chokidar.watch(DOCS_SRC, { ignoreInitial: true });
  await new Promise((resolve, reject) => {
    watcher.once('ready', resolve);
    watcher.once('error', reject);
  });
  // Final mirror pass after watcher is ready closes the gap where a save
  // between setupStaging() and chokidar's initial scan would otherwise be
  // missed (chokidar with ignoreInitial: true won't fire 'change' for files
  // it first observed in their already-changed state).
  await mirrorDocs(DOCS_SRC, DOCS_DST);

  watcher.on('add', (p) => syncOne(p).catch(console.error));
  watcher.on('change', (p) => syncOne(p).catch(console.error));
  watcher.on('unlink', (p) => unlinkOne(p).catch(console.error));
  watcher.on('unlinkDir', (p) => unlinkOne(p).catch(console.error));

  console.log(`🚀 starting mintlify dev on port ${MINTLIFY_PORT}...`);
  const child = spawn(
    'npx',
    ['--yes', 'mintlify@latest', 'dev', '--port', String(MINTLIFY_PORT), '--no-open'],
    {
      cwd: STAGING,
      env: { ...process.env, NODE_PATH: '', NODE_ENV: 'production' },
      stdio: 'inherit',
    },
  );

  // A second SIGINT before cleanup finishes would otherwise hit Node's
  // default handler and kill the process mid-rm, leaving .mintlify-dev/ on
  // disk. Stay subscribed via process.on (not once) and dedupe via the flag.
  let cleaning = false;
  async function cleanup(code) {
    if (cleaning) return;
    cleaning = true;
    await watcher.close().catch(() => {});
    await fs.rm(STAGING, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  }
  child.on('exit', (code) => cleanup(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (!cleaning) child.kill(sig);
      cleanup(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

main().catch((err) => {
  console.error('✗ dev-docs failed:', err.message);
  process.exit(1);
});
